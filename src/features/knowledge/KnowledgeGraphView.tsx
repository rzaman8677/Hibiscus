/**
 * ============================================================================
 * KnowledgeGraphView — Full-Screen Force-Directed Graph (Center Panel)
 * ============================================================================
 *
 * Visually expressive, interactive, cognitively intuitive graph visualization.
 *
 * FEATURES:
 * - Force-directed layout via react-force-graph-2d (ForceGraph2D)
 * - Categorical node colors by file type (md/pdf/docx/txt/other) + legend
 * - Node size encodes degree (connection count); orphans are muted
 * - Neutral edges with an amber highlighted path for the focused node
 * - Node visual system: default, hovered, active, neighbor, dimmed states
 * - Smart label system with zoom-based filtering and background pills
 * - Interaction system: hover highlighting, click-to-focus, smooth camera motion
 * - Focus mode: show only active node + neighbors
 * - Respects prefers-reduced-motion (no camera easing / physics warmup)
 *
 * ACCESSIBILITY:
 * - Color is never the sole signal: the legend pairs every color with a label,
 *   tooltips name the file type, and the backlinks/search panels act as the
 *   list-based alternative to the (inherently visual) graph.
 *
 * PERFORMANCE:
 * - Canvas-based rendering (no DOM per node)
 * - Optimized neighbor lookups via adjacency map
 * - Halos are filled discs, not shadow-blur, to stay cheap per frame
 * ============================================================================
 */

import { useRef, useEffect, useCallback, useMemo, useState } from "react"
import ForceGraph2D from "react-force-graph-2d"
import type { GraphData, GraphNode } from "./buildGraph"
import { useTheme } from "../../state/ThemeContext"
import "./KnowledgeGraph.css"

// =============================================================================
// TYPES
// =============================================================================

interface KnowledgeGraphViewProps {
  graph: GraphData
  activeFilePath: string | null
  /** True while the backend graph is loading (first fetch in flight). */
  loading?: boolean
  /** Error message if the backend graph failed to load. */
  error?: string | null
  onNodeClick: (path: string) => void
  onBack: () => void
}

// Internal node shape for ForceGraph2D (extends GraphNode with layout fields)
interface FGNode extends GraphNode {
  x?: number
  y?: number
  degree: number
  category: FileCategory
  vx?: number
  vy?: number
  fx?: number
  fy?: number
}

interface FGLink {
  source: FGNode | string
  target: FGNode | string
}

type NodeState = "default" | "hovered" | "active" | "neighbor" | "dimmed"

// =============================================================================
// CONSTANTS
// =============================================================================

const MIN_NODE_RADIUS = 4
const MAX_NODE_RADIUS = 16
const HOVER_SCALE = 1.2
const ACTIVE_SCALE = 1.3
const NEIGHBOR_SCALE = 1.08
const DIMMED_OPACITY = 0.18
const LABEL_MIN_ZOOM = 0.4
const LABEL_FADE_START = 0.4
const LABEL_FADE_END = 0.6
const EDGE_FADE_START = 0.2
const EDGE_FADE_END = 0.4
const CAMERA_ANIMATION_DURATION = 800
const FONT_FAMILY = "Inter, system-ui, -apple-system, sans-serif"

// Amber path-highlight color for the focused node's edges (data-viz convention:
// a warm accent that reads as "the path you're looking at" against cool nodes).
const HIGHLIGHT_EDGE = "#f5a623"

// Categorical node colors keyed by file type. This is the one genuinely
// meaningful categorical dimension in the graph, so nodes are colored by it
// (a legend explains the mapping — never color alone). Mid-tone hues chosen to
// stay legible on both light and dark editor backgrounds.
type FileCategory = "md" | "pdf" | "docx" | "txt" | "other"

const CATEGORY_COLORS: Record<FileCategory, string> = {
  md: "#4c8bf5", // notes — blue (the dominant type)
  pdf: "#e0556b", // pdf — rose
  docx: "#2aa9c9", // docx — cyan
  txt: "#6faf4f", // txt — green
  other: "#8891a8", // anything else — slate
}

const CATEGORY_LABELS: Record<FileCategory, string> = {
  md: "Markdown",
  pdf: "PDF",
  docx: "Word",
  txt: "Text",
  other: "Other",
}

// Shape encodes file type alongside color, so the categories stay separable
// without relying on hue (colorblind users, low-contrast displays, dense
// clusters where small color differences wash out).
type NodeShape = "circle" | "square" | "diamond" | "triangle" | "hexagon"

const CATEGORY_SHAPES: Record<FileCategory, NodeShape> = {
  md: "circle",
  pdf: "square",
  docx: "diamond",
  txt: "triangle",
  other: "hexagon",
}

/** Degree at/above which a node is treated as a "hub" and gets an outer ring. */
const HUB_DEGREE_RATIO = 0.6

// Easing function: easeOutCubic
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)

// True when the user has asked the OS to minimize motion.
const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function fileCategory(path: string): FileCategory {
  const lower = path.toLowerCase()
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "md"
  if (lower.endsWith(".pdf")) return "pdf"
  if (lower.endsWith(".docx")) return "docx"
  if (lower.endsWith(".txt")) return "txt"
  return "other"
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null
}

function withAlpha(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
}

/** Lighten a hex color toward white by `amount` (0..1). Used for hover/active glow. */
function lighten(hex: string, amount: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const r = Math.round(rgb.r + (255 - rgb.r) * amount)
  const g = Math.round(rgb.g + (255 - rgb.g) * amount)
  const b = Math.round(rgb.b + (255 - rgb.b) * amount)
  return `rgb(${r}, ${g}, ${b})`
}

/**
 * Trace a node shape onto the canvas path (does not fill or stroke).
 * Shapes are size-compensated so they read as roughly equal visual weight
 * at the same nominal radius.
 */
function traceShape(
  ctx: CanvasRenderingContext2D,
  shape: NodeShape,
  x: number,
  y: number,
  r: number
): void {
  ctx.beginPath()
  switch (shape) {
    case "circle":
      ctx.arc(x, y, r, 0, Math.PI * 2)
      break
    case "square": {
      const s = r * 0.86
      ctx.roundRect(x - s, y - s, s * 2, s * 2, Math.max(1, r * 0.3))
      break
    }
    case "diamond": {
      const d = r * 1.2
      ctx.moveTo(x, y - d)
      ctx.lineTo(x + d, y)
      ctx.lineTo(x, y + d)
      ctx.lineTo(x - d, y)
      ctx.closePath()
      break
    }
    case "triangle": {
      const t = r * 1.22
      ctx.moveTo(x, y - t)
      ctx.lineTo(x + t * 0.866, y + t * 0.55)
      ctx.lineTo(x - t * 0.866, y + t * 0.55)
      ctx.closePath()
      break
    }
    case "hexagon": {
      const h = r * 1.06
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 2
        const px = x + h * Math.cos(angle)
        const py = y + h * Math.sin(angle)
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      break
    }
  }
}

// =============================================================================
// LEGEND GLYPH
// =============================================================================

/** Miniature of a node shape, so the legend matches what's drawn on canvas. */
function LegendGlyph({
  shape,
  color,
  hollow = false,
}: {
  shape: NodeShape
  color: string
  hollow?: boolean
}) {
  const fill = hollow ? "none" : color
  const stroke = color
  const strokeWidth = hollow ? 1.4 : 0.8
  const dash = hollow ? "2.2 1.8" : undefined

  const shapeProps = {
    fill,
    stroke,
    strokeWidth,
    strokeDasharray: dash,
  }

  return (
    <svg
      className="graph-legend-glyph"
      width="13"
      height="13"
      viewBox="0 0 14 14"
      aria-hidden="true"
    >
      {shape === "circle" && <circle cx="7" cy="7" r="4.6" {...shapeProps} />}
      {shape === "square" && <rect x="2.6" y="2.6" width="8.8" height="8.8" rx="2" {...shapeProps} />}
      {shape === "diamond" && <polygon points="7,1.6 12.4,7 7,12.4 1.6,7" {...shapeProps} />}
      {shape === "triangle" && <polygon points="7,1.8 12.4,11.2 1.6,11.2" {...shapeProps} />}
      {shape === "hexagon" && <polygon points="7,1.6 11.7,4.3 11.7,9.7 7,12.4 2.3,9.7 2.3,4.3" {...shapeProps} />}
    </svg>
  )
}

// =============================================================================
// COMPONENT
// =============================================================================

export function KnowledgeGraphView({
  graph,
  activeFilePath,
  loading,
  error,
  onNodeClick,
  onBack,
}: KnowledgeGraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const fgRef = useRef<any>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [clickedNodeId, setClickedNodeId] = useState<string | null>(null)
  const [focusMode, setFocusMode] = useState(false)
  const [globalScale, setGlobalScale] = useState(1)
  const animationRef = useRef<number | null>(null)
  // True while the user is dragging a node — suppresses the auto zoom-to-fit
  // so the camera can't yank out from under them mid-drag.
  const isDraggingRef = useRef(false)

  // Active theme name — used to re-read CSS-variable colors when the theme
  // changes while the graph is mounted (fixes stale colors after a switch).
  const { activeThemeName } = useTheme()

  // ===========================================================================
  // DATA PREPARATION
  // ===========================================================================

  // Compute degree map for node sizing
  const degreeMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const edge of graph.edges) {
      map.set(edge.source, (map.get(edge.source) || 0) + 1)
      map.set(edge.target, (map.get(edge.target) || 0) + 1)
    }
    return map
  }, [graph])

  // Max degree for normalization
  const maxDegree = useMemo(() => {
    let max = 1
    for (const d of degreeMap.values()) {
      if (d > max) max = d
    }
    return max
  }, [degreeMap])

  // Build adjacency map for O(1) neighbor lookups
  const adjacencyMap = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const edge of graph.edges) {
      if (!map.has(edge.source)) map.set(edge.source, new Set())
      if (!map.has(edge.target)) map.set(edge.target, new Set())
      map.get(edge.source)!.add(edge.target)
      map.get(edge.target)!.add(edge.source)
    }
    return map
  }, [graph])

  // Build ForceGraph2D-compatible data
  const fgData = useMemo(() => {
    const nodes: FGNode[] = graph.nodes.map((n) => ({
      ...n,
      degree: degreeMap.get(n.id) || 0,
      category: fileCategory(n.id),
    }))

    const links: FGLink[] = graph.edges.map((e) => ({
      source: e.source,
      target: e.target,
    }))

    return { nodes, links }
  }, [graph, degreeMap])

  // Which file categories actually appear, in a stable order, for the legend.
  const presentCategories = useMemo(() => {
    const order: FileCategory[] = ["md", "pdf", "docx", "txt", "other"]
    const present = new Set(fgData.nodes.map((n) => n.category))
    return order.filter((c) => present.has(c))
  }, [fgData])

  // Legend visibility (collapsible so it never fights the graph on small panes).
  const [showLegend, setShowLegend] = useState(true)

  // Node radius based on degree
  const getNodeRadius = useCallback(
    (node: FGNode) => {
      const t = maxDegree > 1 ? node.degree / maxDegree : 0
      return MIN_NODE_RADIUS + t * (MAX_NODE_RADIUS - MIN_NODE_RADIUS)
    },
    [maxDegree]
  )

  // Get effective radius with state-based scaling
  const getEffectiveRadius = useCallback(
    (node: FGNode, state: NodeState) => {
      const baseRadius = getNodeRadius(node)
      switch (state) {
        case "active":
          return baseRadius * ACTIVE_SCALE
        case "hovered":
          return baseRadius * HOVER_SCALE
        case "neighbor":
          return baseRadius * NEIGHBOR_SCALE
        default:
          return baseRadius
      }
    },
    [getNodeRadius]
  )

  // Determine node state based on current interaction context
  const getNodeState = useCallback(
    (nodeId: string): NodeState => {
      if ((clickedNodeId || activeFilePath) === nodeId) return "active"
      if (hoveredNodeId === nodeId) return "hovered"

      // Check if this node is a neighbor of hovered or clicked node
      const focusId = clickedNodeId || hoveredNodeId || activeFilePath
      if (focusId) {
        const neighbors = adjacencyMap.get(focusId)
        if (neighbors?.has(nodeId)) return "neighbor"
      }

      // In focus mode, non-neighbors are dimmed
      if (focusMode && focusId) {
        const neighbors = adjacencyMap.get(focusId)
        if (!neighbors?.has(nodeId) && nodeId !== focusId) return "dimmed"
      }

      // In hover state without focus mode, non-neighbors are slightly dimmed
      if (hoveredNodeId && !focusMode) {
        const neighbors = adjacencyMap.get(hoveredNodeId)
        if (!neighbors?.has(nodeId) && nodeId !== hoveredNodeId) return "dimmed"
      }

      return "default"
    },
    [clickedNodeId, hoveredNodeId, activeFilePath, adjacencyMap, focusMode]
  )

  // Check if a link should be highlighted
  const getLinkState = useCallback(
    (link: FGLink): "highlighted" | "dimmed" | "default" => {
      const sourceId = typeof link.source === "string" ? link.source : link.source.id
      const targetId = typeof link.target === "string" ? link.target : link.target.id

      const focusId = clickedNodeId || hoveredNodeId
      if (!focusId) return "default"

      // Link is highlighted if connected to focus node
      if (sourceId === focusId || targetId === focusId) return "highlighted"

      // In focus mode, non-connected links are dimmed
      if (focusMode) return "dimmed"

      return "default"
    },
    [clickedNodeId, hoveredNodeId, focusMode]
  )

  // ===========================================================================
  // THEME COLORS
  // ===========================================================================

  // Resolve theme colors from CSS variables at render time
  const colors = useMemo(() => {
    const root = document.documentElement
    const style = getComputedStyle(root)
    return {
      bg: style.getPropertyValue("--editor-bg").trim() || "#0a0d12",
      text: style.getPropertyValue("--text").trim() || "#e6e6eb",
      textMuted: style.getPropertyValue("--text-muted").trim() || "#8b92a8",
      textSubtle: style.getPropertyValue("--text-subtle").trim() || "#5c6370",
      accent: style.getPropertyValue("--accent").trim() || "#7aa2f7",
      accentSecondary: style.getPropertyValue("--accent-secondary").trim() || "#bb9af7",
      border: style.getPropertyValue("--border").trim() || "rgba(255,255,255,0.06)",
      panelBg: style.getPropertyValue("--panel-bg").trim() || "#131720",
      panelBgHover: style.getPropertyValue("--panel-bg-hover").trim() || "#1a1f2e",
      accentSoft: style.getPropertyValue("--accent-soft").trim() || "rgba(122, 162, 247, 0.15)",
      // Neutral edge color (blue-gray) — data-viz convention for "connective
      // tissue" that shouldn't compete with the categorical node colors.
      edge: style.getPropertyValue("--text-subtle").trim() || "#5c6370",
    }
    // Re-read on data change or when the active theme changes so colors stay
    // in sync with a live theme switch, not just when graph data updates.
  }, [fgData, activeThemeName])

  // ===========================================================================
  // LABEL VISIBILITY LOGIC
  // ===========================================================================

  // Determine if label should be shown for a node
  const shouldShowLabel = useCallback(
    (nodeId: string, zoom: number): boolean => {
      const state = getNodeState(nodeId)

      // Always show labels for active and hovered nodes
      if (state === "active" || state === "hovered") return true

      // Show neighbor labels when hovering
      if (hoveredNodeId && state === "neighbor") return true

      // Hide labels at low zoom levels
      if (zoom < LABEL_MIN_ZOOM) return false

      return true
    },
    [getNodeState, hoveredNodeId]
  )

  // Calculate label opacity based on zoom for smooth fade
  const getLabelOpacity = useCallback((zoom: number): number => {
    if (zoom >= LABEL_FADE_END) return 1
    if (zoom <= LABEL_FADE_START) return 0
    return (zoom - LABEL_FADE_START) / (LABEL_FADE_END - LABEL_FADE_START)
  }, [])

  // ===========================================================================
  // CAMERA MOTION
  // ===========================================================================

  // Smooth camera centering on node
  const centerOnNode = useCallback(
    (node: FGNode) => {
      if (!fgRef.current || node.x == null || node.y == null) return

      // Cancel any existing animation
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }

      // Respect reduced-motion: jump straight to the target instead of easing.
      if (prefersReducedMotion()) {
        const z = Math.max(1.5, fgRef.current.getTransform?.().k ?? 1.5)
        fgRef.current.centerAt(node.x, node.y, z)
        return
      }

      const startTime = performance.now()
      const startTransform = fgRef.current.getTransform()
      const targetX = node.x
      const targetY = node.y
      const targetZoom = Math.max(1.5, startTransform.k)

      const animate = (currentTime: number) => {
        const elapsed = currentTime - startTime
        const progress = Math.min(elapsed / CAMERA_ANIMATION_DURATION, 1)
        const eased = easeOutCubic(progress)

        const currentX = startTransform.x + (targetX * targetZoom - startTransform.x) * eased
        const currentY = startTransform.y + (targetY * targetZoom - startTransform.y) * eased
        const currentZoom = startTransform.k + (targetZoom - startTransform.k) * eased

        fgRef.current.centerAt(currentX / currentZoom, currentY / currentZoom, currentZoom)

        if (progress < 1) {
          animationRef.current = requestAnimationFrame(animate)
        } else {
          animationRef.current = null
        }
      }

      animationRef.current = requestAnimationFrame(animate)
    },
    []
  )

  // ===========================================================================
  // EVENT HANDLERS
  // ===========================================================================

  // Handle node hover
  const handleNodeHover = useCallback(
    (node: any) => {
      const nodeId = node?.id ?? null
      setHoveredNodeId(nodeId)
    },
    []
  )

  // Handle node click
  const handleNodeClick = useCallback(
    (node: any) => {
      if (node?.id) {
        const nodeId = node.id as string
        const fgNode = node as FGNode

        setClickedNodeId(nodeId)
        setFocusMode(true)
        centerOnNode(fgNode)
        onNodeClick(nodeId)
      }
    },
    [onNodeClick, centerOnNode]
  )

  // Handle background click to reset focus
  const handleBackgroundClick = useCallback(() => {
    setClickedNodeId(null)
    setFocusMode(false)
  }, [])

  // Drag lifecycle. Dragging reheats the d3 simulation; without pinning, the
  // released node springs back and the whole cloud keeps drifting afterwards.
  const handleNodeDrag = useCallback(() => {
    isDraggingRef.current = true
  }, [])

  const handleNodeDragEnd = useCallback((node: any) => {
    isDraggingRef.current = false
    // Pin the node where it was dropped so the user's arrangement sticks.
    node.fx = node.x
    node.fy = node.y
  }, [])

  // Fit the whole graph back into view (also the manual recovery button).
  const fitToView = useCallback(() => {
    fgRef.current?.zoomToFit(prefersReducedMotion() ? 0 : 400, 60)
  }, [])

  // Release all pinned positions and let the layout re-settle from scratch.
  const relayout = useCallback(() => {
    for (const node of fgData.nodes as any[]) {
      node.fx = undefined
      node.fy = undefined
    }
    fgRef.current?.d3ReheatSimulation?.()
    setTimeout(fitToView, 600)
  }, [fgData, fitToView])

  // Handle zoom change
  const handleZoom = useCallback((transform: any) => {
    setGlobalScale(transform.k)
  }, [])

  // Exit focus mode
  const exitFocusMode = useCallback(() => {
    setClickedNodeId(null)
    setFocusMode(false)
  }, [])

  // ===========================================================================
  // CANVAS RENDERING
  // ===========================================================================

  // Custom node rendering on canvas
  const paintNode = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, zoom: number) => {
      const fgNode = node as FGNode
      const state = getNodeState(fgNode.id)
      const radius = getEffectiveRadius(fgNode, state)
      const x = node.x ?? 0
      const y = node.y ?? 0

      // Color AND shape both encode the file-type category, so nodes stay
      // separable without relying on hue alone.
      const categoryColor = CATEGORY_COLORS[fgNode.category]
      const shape = CATEGORY_SHAPES[fgNode.category]

      // Structural roles: hubs (most-linked) get an outer ring, orphans
      // (nothing links to or from them) are drawn hollow with a dashed contour.
      const isOrphan = fgNode.degree === 0
      const isHub = maxDegree > 2 && fgNode.degree >= maxDegree * HUB_DEGREE_RATIO
      const drawHollow = isOrphan && (state === "default" || state === "neighbor")

      let fillColor = categoryColor
      let strokeColor = withAlpha(categoryColor, 0.5)
      let strokeWidth = 0.9
      let opacity = 1
      let haloColor: string | null = null

      switch (state) {
        case "active":
          fillColor = lighten(categoryColor, 0.14)
          strokeColor = colors.text
          strokeWidth = 2.2
          haloColor = withAlpha(categoryColor, 0.3)
          break
        case "hovered":
          fillColor = lighten(categoryColor, 0.18)
          strokeColor = colors.text
          strokeWidth = 1.6
          haloColor = withAlpha(categoryColor, 0.22)
          break
        case "neighbor":
          fillColor = categoryColor
          strokeColor = withAlpha(colors.text, 0.6)
          strokeWidth = 1.2
          break
        case "dimmed":
          opacity = DIMMED_OPACITY
          fillColor = colors.textMuted
          strokeColor = withAlpha(colors.textMuted, 0.3)
          break
      }

      ctx.globalAlpha = opacity

      // Soft halo behind hovered/active nodes (a filled shape, not a shadow-blur,
      // so it stays cheap per frame).
      if (haloColor) {
        traceShape(ctx, shape, x, y, radius + 6)
        ctx.fillStyle = haloColor
        ctx.fill()
      }

      // Hub ring — marks the most connected notes in the workspace.
      if (isHub && state !== "dimmed") {
        traceShape(ctx, shape, x, y, radius + 3.5)
        ctx.strokeStyle = withAlpha(categoryColor, 0.5)
        ctx.lineWidth = 1
        ctx.stroke()
      }

      // Node body
      traceShape(ctx, shape, x, y, radius)
      if (drawHollow) {
        ctx.fillStyle = withAlpha(colors.bg, 0.85)
        ctx.fill()
        ctx.setLineDash([2.5, 2])
        ctx.strokeStyle = withAlpha(categoryColor, 0.85)
        ctx.lineWidth = 1.2
        ctx.stroke()
        ctx.setLineDash([])
      } else {
        ctx.fillStyle = fillColor
        ctx.fill()
        ctx.strokeStyle = strokeColor
        ctx.lineWidth = strokeWidth
        ctx.stroke()
      }

      // Reset alpha
      ctx.globalAlpha = 1

      // Label rendering
      if (shouldShowLabel(fgNode.id, zoom)) {
        const labelOpacity = state === "active" || state === "hovered" ? 1 : getLabelOpacity(zoom)

        if (labelOpacity > 0) {
          ctx.globalAlpha = labelOpacity

          const fontSize = Math.max(11 / Math.sqrt(zoom), 8)
          ctx.font = `${state === "active" ? "600" : "500"} ${fontSize}px ${FONT_FAMILY}`
          ctx.textAlign = "center"
          ctx.textBaseline = "middle"

          const text = fgNode.label
          const textMetrics = ctx.measureText(text)
          const textWidth = textMetrics.width
          const textHeight = fontSize
          const paddingX = 6
          const paddingY = 3
          const labelY = y + radius + fontSize * 0.8 + 4

          // Background pill for readability
          const pillWidth = textWidth + paddingX * 2
          const pillHeight = textHeight + paddingY * 2
          const pillRadius = 4

          ctx.fillStyle = withAlpha(colors.bg, 0.85)
          ctx.beginPath()
          ctx.roundRect(
            x - pillWidth / 2,
            labelY - pillHeight / 2,
            pillWidth,
            pillHeight,
            pillRadius
          )
          ctx.fill()

          // Label text
          ctx.fillStyle = state === "active" ? colors.text : state === "dimmed" ? colors.textSubtle : colors.textMuted
          ctx.fillText(text, x, labelY)

          ctx.globalAlpha = 1
        }
      }
    },
    [colors, getNodeState, getEffectiveRadius, shouldShowLabel, getLabelOpacity, maxDegree]
  )

  // Link rendering
  const paintLink = useCallback(
    (link: any, ctx: CanvasRenderingContext2D, zoom: number) => {
      const source = link.source as FGNode
      const target = link.target as FGNode
      if (!source || !target) return

      const state = getLinkState(link)
      const linkOpacity =
        zoom < EDGE_FADE_START ? 0 : zoom < EDGE_FADE_END ? (zoom - EDGE_FADE_START) / (EDGE_FADE_END - EDGE_FADE_START) : 1

      // Neutral edges by default; the focused node's edges glow amber so the
      // active path pops against the cool categorical nodes.
      let strokeColor = withAlpha(colors.edge, 0.35 * linkOpacity)
      let lineWidth = 0.6

      switch (state) {
        case "highlighted":
          strokeColor = withAlpha(HIGHLIGHT_EDGE, 0.85 * linkOpacity)
          lineWidth = 1.6
          break
        case "dimmed":
          strokeColor = withAlpha(colors.edge, 0.1 * linkOpacity)
          lineWidth = 0.4
          break
        default:
          strokeColor = withAlpha(colors.edge, 0.32 * linkOpacity)
          lineWidth = 0.6
      }

      ctx.beginPath()
      ctx.moveTo(source.x ?? 0, source.y ?? 0)
      ctx.lineTo(target.x ?? 0, target.y ?? 0)
      ctx.strokeStyle = strokeColor
      ctx.lineWidth = lineWidth
      ctx.stroke()
    },
    [colors, getLinkState]
  )

  // Pointer area for hit testing
  const paintPointerArea = useCallback(
    (node: any, color: string, ctx: CanvasRenderingContext2D) => {
      const fgNode = node as FGNode
      const state = getNodeState(fgNode.id)
      const radius = getEffectiveRadius(fgNode, state)
      ctx.beginPath()
      ctx.arc(node.x ?? 0, node.y ?? 0, radius + 4, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
    },
    [getNodeState, getEffectiveRadius]
  )

  // Node tooltip
  const getNodeLabel = useCallback(
    (node: any) => {
      const fgNode = node as FGNode
      const connections = fgNode.degree
      const type = CATEGORY_LABELS[fgNode.category]
      return `${fgNode.label} · ${type} · ${connections} connection${connections !== 1 ? "s" : ""}`
    },
    []
  )

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  // Observe container size for responsive graph
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          setDimensions({
            width: Math.floor(width),
            height: Math.floor(height),
          })
        }
      }
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Constrain the force layout.
  //
  // BUG FIX: with d3's default forces the repulsion between nodes is unbounded
  // and there is no meaningful pull back toward the origin. Dragging a node
  // reheats the simulation, and on reheat the whole cloud expanded outward
  // until nodes drifted outside the viewport. Capping charge distance and
  // adding a centering pull keeps the layout's overall extent stable across
  // reheats, so a drag moves what you grabbed instead of blowing the graph up.
  useEffect(() => {
    const fg = fgRef.current
    if (!fg?.d3Force) return

    fg.d3Force("charge")?.strength(-120).distanceMax(360)
    fg.d3Force("link")?.distance(58).strength(0.6)

    // d3-force v3 exposes strength() on the centering force.
    const center = fg.d3Force("center")
    if (typeof center?.strength === "function") center.strength(0.06)
  }, [fgData])

  // Identity of the node set — changes only when notes are actually added or
  // removed, not on every re-render.
  const nodeSignature = useMemo(
    () => fgData.nodes.map((n) => n.id).join(" "),
    [fgData]
  )

  // Fit the graph when the node set changes. Skipped while dragging so the
  // camera never moves out from under the pointer.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!isDraggingRef.current) fitToView()
    }, 500)
    return () => clearTimeout(timer)
  }, [nodeSignature, fitToView])

  // Cleanup animation on unmount
  useEffect(() => {
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [])

  // ===========================================================================
  // RENDER
  // ===========================================================================

  // Shared header for the non-graph states (loading / error / empty).
  const stateHeader = (
    <div className="graph-view-header">
      <button className="graph-view-back" onClick={onBack} title="Back to Editor">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 12L6 8L10 4" />
        </svg>
        <span>Editor</span>
      </button>
      <span className="graph-view-title">Knowledge Graph</span>
      <span className="graph-view-stats" />
    </div>
  )

  // Error state — surfaced instead of silently falling back to a different graph.
  if (error && graph.nodes.length === 0) {
    return (
      <div className="graph-view">
        {stateHeader}
        <div className="graph-view-empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <span className="graph-view-empty-title">Couldn't load the knowledge graph</span>
          <span className="graph-view-empty-hint">{error}</span>
        </div>
      </div>
    )
  }

  // Loading state — only shown before we have any nodes to draw.
  if (loading && graph.nodes.length === 0) {
    return (
      <div className="graph-view">
        {stateHeader}
        <div className="graph-view-empty">
          <span className="graph-view-spinner" aria-hidden="true" />
          <span className="graph-view-empty-title">Building the knowledge graph…</span>
          <span className="graph-view-empty-hint">Indexing your notes and resolving links</span>
        </div>
      </div>
    )
  }

  // Empty state
  if (graph.nodes.length === 0) {
    return (
      <div className="graph-view">
        {stateHeader}
        <div className="graph-view-empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="12" r="2.5" />
            <circle cx="18" cy="6" r="2.5" />
            <circle cx="18" cy="18" r="2.5" />
            <path d="M8.5 11L15.5 7M8.5 13L15.5 17" />
          </svg>
          <span className="graph-view-empty-title">No linked notes</span>
          <span className="graph-view-empty-hint">Use [[note name]] syntax to create links between your notes</span>
        </div>
      </div>
    )
  }

  return (
    <div className="graph-view">
      {/* Header overlay */}
      <div className="graph-view-header">
        <button className="graph-view-back" onClick={onBack} title="Back to Editor (Ctrl+G)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 12L6 8L10 4" />
          </svg>
          <span>Editor</span>
        </button>
        <span className="graph-view-title">Knowledge Graph</span>
        <div className="graph-view-actions">
          <button
            className="graph-view-back"
            onClick={fitToView}
            title="Fit all notes in view"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
            </svg>
            <span>Fit</span>
          </button>
          <button
            className="graph-view-back"
            onClick={relayout}
            title="Unpin every node and re-run the layout"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-3-6.7" />
              <path d="M21 3v6h-6" />
            </svg>
            <span>Relayout</span>
          </button>
          {focusMode && (
            <button
              className="graph-view-back"
              onClick={exitFocusMode}
              title="Exit focus mode (show full graph)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
                <path d="M8 11h6" />
                <path d="M11 8v6" />
              </svg>
              <span>Reset View</span>
            </button>
          )}
          <span className="graph-view-stats">
            {graph.nodes.length} notes / {graph.edges.length} links / {globalScale.toFixed(1)}x
          </span>
        </div>
      </div>

      {/* Graph canvas container */}
      <div className="graph-view-canvas" ref={containerRef}>
        <ForceGraph2D
          ref={fgRef}
          width={dimensions.width}
          height={dimensions.height}
          graphData={fgData}
          // Node rendering
          nodeCanvasObject={paintNode}
          nodePointerAreaPaint={paintPointerArea}
          nodeLabel={getNodeLabel}
          // Link rendering
          linkCanvasObject={paintLink}
          // Interactions
          onNodeHover={handleNodeHover}
          onNodeClick={handleNodeClick}
          onNodeDrag={handleNodeDrag}
          onNodeDragEnd={handleNodeDragEnd}
          onBackgroundClick={handleBackgroundClick}
          onZoom={handleZoom}
          // Layout
          backgroundColor={colors.bg}
          // Physics tuning. Higher velocity decay (more friction) keeps a drag
          // reheat from flinging the rest of the graph outward; see the force
          // configuration effect above for the charge/centering constraints.
          d3AlphaDecay={0.028}
          d3VelocityDecay={0.42}
          warmupTicks={prefersReducedMotion() ? 120 : 50}
          cooldownTicks={prefersReducedMotion() ? 0 : 200}
          // Enable zoom/pan
          enableZoomInteraction={true}
          enablePanInteraction={true}
          enableNodeDrag={true}
        />

        {/* Legend — explains node shape + color (file type), size (connections),
            and the hollow/ring structural markers. Color is never the sole
            signal: shape and a text label carry the same information. */}
        {presentCategories.length > 0 && (
          <div className={`graph-legend ${showLegend ? "" : "graph-legend-collapsed"}`}>
            <button
              className="graph-legend-toggle"
              onClick={() => setShowLegend((v) => !v)}
              title={showLegend ? "Hide legend" : "Show legend"}
              aria-expanded={showLegend}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8h.01M11 12h1v4h1" />
              </svg>
              <span>Legend</span>
            </button>
            {showLegend && (
              <div className="graph-legend-body">
                <ul className="graph-legend-list">
                  {presentCategories.map((cat) => (
                    <li key={cat} className="graph-legend-item">
                      <LegendGlyph shape={CATEGORY_SHAPES[cat]} color={CATEGORY_COLORS[cat]} />
                      <span>{CATEGORY_LABELS[cat]}</span>
                    </li>
                  ))}
                </ul>
                <div className="graph-legend-hint">
                  <span className="graph-legend-sizes" aria-hidden="true">
                    <span className="graph-legend-dot graph-legend-dot-sm" />
                    <span className="graph-legend-dot graph-legend-dot-lg" />
                  </span>
                  <span>Size = connections</span>
                </div>
                <div className="graph-legend-hint">
                  <LegendGlyph shape="circle" color={colors.textSubtle} hollow />
                  <span>Dashed = unlinked</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
