# Knowledge Graph Architecture

This document details the technical architecture of Hibiscus's knowledge graph system, including data structures, algorithms, and integration patterns.

## System Overview

The knowledge graph system has two cooperating layers:

**Backend (canonical source of truth)**: The Rust pipeline indexes all files — Markdown, plain text, PDF, and DOCX — into a persisted, content-addressable chunk store. Graph nodes and backlink maps are derived from this store and surfaced via `get_knowledge_graph` and `get_backlinks` Tauri commands. This data survives restarts and reflects the full workspace including binary document content.

**Frontend (live in-editor layer)**: `useKnowledgeIndex` continues to provide real-time wiki-link and tag parsing for the active buffer while the user types, driving live backlink counts before a file is saved. It is intentionally scoped to Markdown and should not be used as the graph or backlinks data source.

`useBackendKnowledge` is the correct hook for any component that consumes the graph or backlinks. It replaces a previous 5-second polling interval with reactive `fs-changed` / `knowledge-updated` event listeners, meaning the graph updates within ~600ms of a file save rather than on a fixed schedule.

### What each layer owns

| Concern | Layer |
|---|---|
| Graph visualization data | Backend (`get_knowledge_graph`) |
| Backlinks panel data | Backend (`get_backlinks`) |
| Search results | Backend (`search_chunks`) |
| Live wiki-link highlighting in editor | Frontend (`useKnowledgeIndex`) |
| PDF / DOCX content in graph | Backend only |

## Core Components

### 1. Knowledge Index (`useKnowledgeIndex`)

The central hook that maintains the knowledge state.

```typescript
interface KnowledgeIndex {
  notes: Map<string, IndexedNote>
  backlinks: Map<string, string[]>
  version: number
}
```

#### Key Features

- **Incremental Updates**: Only re-parses changed files
- **Bidirectional Links**: Maintains both forward and backward references
- **Version Tracking**: Enables efficient memoization in consumers
- **Concurrent Protection**: Guards against race conditions

#### Parsing Logic

```typescript
// Wiki-link extraction
const LINK_RE = /\[\[(.*?)\]\]/g

// Tag extraction  
const TAG_RE = /(^|\s)#([a-zA-Z0-9\-_]+)/g
```

### 2. Graph Builder (`buildGraph`)

Converts the knowledge index into a renderable graph structure.

```typescript
interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}
```

#### Algorithm

1. **Node Creation**: One node per indexed note
2. **Link Resolution**: Name-based matching (case-insensitive)
3. **Edge Deduplication**: Prevents duplicate connections
4. **Unresolved Handling**: Safely ignores broken links

#### Performance Characteristics

- **Time Complexity**: O(n + m) where n = notes, m = links
- **Space Complexity**: O(n + m)
- **Deduplication**: Set-based edge filtering

### 3. Graph Visualization (`KnowledgeGraphView`)

Full-screen force-directed graph component using `react-force-graph-2d`. Canvas-rendered via D3 with custom `nodeCanvasObject` for all node drawing.

#### Node Visual Encoding

Nodes encode file type through **both colour and shape** so they remain distinguishable in colour-blind contexts and at small sizes.

| File type | Colour | Shape |
|---|---|---|
| Markdown | Blue (`#7aa2f7`) | Circle |
| PDF | Red (`#f7768e`) | Diamond |
| DOCX / Word | Green (`#9ece6a`) | Square |
| Plain text | Yellow (`#e0af68`) | Triangle |
| Other | Muted (`#565f89`) | Hexagon |

High-degree "hub" nodes render with an additional ring at 130% radius. Orphan nodes (zero connections) render hollow to visually distinguish them from connected nodes. Hovered edges turn amber (`#f5a623`).

#### Drag Behaviour Fix

A previous bug caused the simulation to explode when a node was dragged — all non-dragged nodes would zoom out and leave the viewport. This was fixed by:
1. Setting `alphaTarget(0.3)` on drag start (prevents the simulation from cooling) and resetting to `0` on release.
2. Capping `d3ManyBodyStrength` and constraining forces so the simulation energy stays bounded.
3. Tracking a `isDraggingRef` flag to suppress camera re-centering while a drag is active.

#### Fit / Relayout

Two toolbar buttons in the graph header:
- **Fit** — calls `zoomToFit()` with a guard for `prefers-reduced-motion` (skips animation if the user has it enabled).
- **Relayout** — reheats the simulation (`alpha(1)`) to re-run the force layout from the current positions, useful when nodes have drifted after a large graph update.

#### Legend

A collapsible legend panel (bottom-left) lists each file-type category with its matching colour swatch and shape glyph rendered as inline SVG. The legend collapses to a single toggle button to free viewport space on small screens.

#### Physics Configuration

```typescript
{
  d3AlphaDecay: 0.02,
  d3VelocityDecay: 0.3,
  d3ManyBodyStrength: -120,  // bounded to prevent explosion
  warmupTicks: 50,
  cooldownTicks: 200
}
```

### 4. Backlinks Panel (`BacklinksPanel`)

Displays incoming links to the current file.

#### Data Flow

1. **Current Path**: Receives the active file path as a prop.
2. **Backlink Lookup**: Receives a pre-resolved `string[]` of source paths — the component no longer touches `KnowledgeIndex` directly. The resolved list comes from `useBackendKnowledge().backlinks[activePath]`.
3. **UI Rendering**: Lists clickable backlink sources with filename display.
4. **Navigation**: Calls `onOpenFile` to open the source note on click.

This consolidation means there is one place (`App.tsx` via `useBackendKnowledge`) that owns backlink resolution, rather than two competing sources.

## Data Flow Architecture

### Initialization Flow

```
Workspace Files → flattenFiles() → parseNote() → buildIndex() → GraphData
```

### Update Flow

```
File Change → updateNote() → Backlink Update → Version Increment → Re-render
```

### Rendering Flow

```
KnowledgeIndex → buildGraph() → GraphData → ForceGraph2D → Canvas
```

## Performance Optimizations

### 1. Incremental Updates

- **Single File Parsing**: Only changed files are re-parsed
- **Backlink Delta**: Remove old links, add new links
- **Version Bumping**: Triggers selective re-renders

### 2. Memory Management

- **Map Structures**: O(1) lookups for notes and backlinks
- **Set Deduplication**: Prevents duplicate entries
- **Memoization**: React.memo and useMemo for expensive operations

### 3. Rendering Optimization

- **Canvas-based**: No DOM per node overhead
- **Level-of-Detail**: Labels only at sufficient zoom
- **Resize Throttling**: ResizeObserver with debounced updates

## Integration Patterns

### Editor Integration

```typescript
// File buffer monitoring
const buffersRef = useRef<Map<string, FileBuffer>>()

// Incremental updates on content change
const updateNote = useCallback((path: string, content: string) => {
  // Update single note in index
}, [])
```

### Theme System Integration

```typescript
// Dynamic color resolution
const colors = useMemo(() => {
  const root = document.documentElement
  const style = getComputedStyle(root)
  return {
    bg: style.getPropertyValue("--editor-bg").trim(),
    accent: style.getPropertyValue("--accent").trim(),
    // ... other theme colors
  }
}, [fgData])
```

### Search System Integration

- **Shared Index**: Knowledge index available to search
- **Link Context**: Search results include link information
- **Navigation**: Jump from search to graph nodes

## File Structure

```
src/features/knowledge/
├── KnowledgeGraphView.tsx    # Main graph component (canvas, legend, toolbar)
├── KnowledgeGraph.css        # Graph-specific styles + legend
├── buildGraph.ts             # Graph data builder (GraphData type)
├── useKnowledgeIndex.ts      # Frontend-only live indexing (editor use only)
├── useBackendKnowledge.ts    # Canonical backend graph + backlinks hook
├── BacklinksPanel.tsx        # Backlinks UI (receives resolved string[])
└── BacklinksPanel.css        # Backlinks styles
```

## Algorithm Details

### Link Resolution Algorithm

```typescript
function resolveLinks(notes: Map<string, IndexedNote>): Map<string, string[]> {
  const backlinks = new Map<string, string[]>()
  const nameToPath = new Map<string, string>()
  
  // Build name→path lookup
  for (const [path, note] of notes.entries()) {
    nameToPath.set(note.name.toLowerCase(), path)
  }
  
  // Resolve each note's links
  for (const [sourcePath, note] of notes.entries()) {
    for (const linkTarget of note.links) {
      const targetPath = nameToPath.get(linkTarget.toLowerCase())
      if (targetPath && targetPath !== sourcePath) {
        // Add backlink entry
        const existing = backlinks.get(targetPath) || []
        if (!existing.includes(sourcePath)) {
          backlinks.set(targetPath, [...existing, sourcePath])
        }
      }
    }
  }
  
  return backlinks
}
```

### Graph Layout Algorithm

Uses D3's force simulation with custom tuning:

- **Charge**: Node repulsion (prevents overlap)
- **Link**: Distance constraints between connected nodes
- **Center**: Keeps graph centered in viewport
- **Collision**: Prevents node overlap

## State Management

### React State Pattern

```typescript
const [index, setIndex] = useState<KnowledgeIndex>({
  notes: new Map(),
  backlinks: new Map(),
  version: 0
})
```

### Update Pattern

```typescript
const updateNote = useCallback((path: string, content: string) => {
  setIndex(prev => {
    const notes = new Map(prev.notes)
    const backlinks = new Map(prev.backlinks)
    
    // Remove old backlinks
    removeBacklinksFrom(backlinks, path)
    
    // Parse updated content
    const note = parseNote(path, content)
    notes.set(path, note)
    
    // Add new backlinks
    addBacklinksFrom(backlinks, notes, path, note.links)
    
    return { notes, backlinks, version: prev.version + 1 }
  })
}, [])
```

## Error Handling

### Graceful Degradation

- **Unresolved Links**: Ignored without breaking graph
- **Parse Errors**: Individual files skipped, system continues
- **Memory Limits**: Natural bounds through file filtering

### Validation

- **File Extension Filtering**: Only supported formats indexed
- **Link Syntax Validation**: Regex-based parsing with error tolerance
- **Path Normalization**: Cross-platform path handling

## Testing Considerations

### Unit Tests

- **Link Parsing**: Regex extraction accuracy
- **Graph Building**: Correct node/edge generation
- **Backlink Resolution**: Bidirectional link accuracy

### Integration Tests

- **Editor Integration**: File change propagation
- **Theme Integration**: Color variable resolution
- **Performance**: Large knowledge base handling

### Performance Tests

- **Incremental Updates**: Single file change performance
- **Memory Usage**: Large graph memory footprint
- **Render Performance**: Canvas frame rate maintenance

## Future Extensibility

### Planned Enhancements

- **Advanced Layout**: Hierarchical and clustering layouts
- **Link Types**: Differentiated link relationships (citation vs. reference vs. embed)
- **Graph Analytics**: Connection metrics and insights (PageRank, community detection)

### Architecture Preparedness

- **Plugin System**: Extensible parser architecture
- **Storage Backend**: Pluggable storage backends
- **Visualization Engine**: Swappable graph libraries
- **Search Integration**: Enhanced search-graph synergy

## Dependencies

### Core Libraries

- **react-force-graph-2d**: Graph visualization engine
- **React**: Component framework and state management
- **TypeScript**: Type safety and developer experience

### Internal Dependencies

- **Workspace System**: File tree and buffer management
- **Theme System**: CSS variable integration
- **Editor System**: File content and navigation

---

This architecture is designed for performance, maintainability, and extensibility while integrating seamlessly with Hibiscus's existing systems.
