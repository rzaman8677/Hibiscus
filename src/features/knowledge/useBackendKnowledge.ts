/**
 * ============================================================================
 * useBackendKnowledge — Canonical Knowledge Graph Source
 * ============================================================================
 *
 * Fetches the persisted knowledge graph + backlinks from the Rust backend,
 * which is the single source of truth (chunk-based, PDF/DOCX-aware, survives
 * restarts). Refreshes reactively when the filesystem watcher reports a change
 * ("fs-changed" event) instead of polling on a fixed interval.
 *
 * The frontend-only useKnowledgeIndex remains for live in-editor link/tag
 * detection; this hook is what the graph and backlinks views should consume.
 * ============================================================================
 */

import { useState, useEffect, useCallback, useRef } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type { GraphData } from "./buildGraph"

export type BacklinkMap = Record<string, string[]>

export interface BackendKnowledge {
  /** Backend graph, or null if unavailable / not yet loaded. */
  graph: GraphData | null
  /** Backend backlink map (target path -> source paths). */
  backlinks: BacklinkMap | null
  /** True while the first load is in flight. */
  loading: boolean
  /** Error message if the backend graph could not be loaded, else null. */
  error: string | null
  /** Manually trigger a refetch. */
  refresh: () => void
}

/** Debounce window for coalescing rapid fs-changed events before refetching. */
const REFRESH_DEBOUNCE_MS = 600

export function useBackendKnowledge(workspaceRoot: string | null): BackendKnowledge {
  const [graph, setGraph] = useState<GraphData | null>(null)
  const [backlinks, setBacklinks] = useState<BacklinkMap | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cancelledRef = useRef(false)

  const load = useCallback(async () => {
    if (!workspaceRoot) return
    setLoading(true)
    try {
      const [g, b] = await Promise.all([
        invoke<GraphData>("get_knowledge_graph"),
        invoke<BacklinkMap>("get_backlinks"),
      ])
      if (cancelledRef.current) return
      setGraph(g?.nodes?.length ? g : { nodes: [], edges: [] })
      setBacklinks(b ?? {})
      setError(null)
    } catch (e) {
      if (cancelledRef.current) return
      setError(typeof e === "string" ? e : "Failed to load knowledge graph")
    } finally {
      if (!cancelledRef.current) setLoading(false)
    }
  }, [workspaceRoot])

  useEffect(() => {
    cancelledRef.current = false
    if (!workspaceRoot) {
      setGraph(null)
      setBacklinks(null)
      setError(null)
      return
    }

    load()

    // Refresh when the filesystem watcher reports changes (debounced), so the
    // graph tracks edits without a wasteful fixed-interval poll.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let unlisten: (() => void) | null = null

    listen("fs-changed", () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        // Backend indexing is itself debounced (~750ms); wait a beat so the
        // freshly re-indexed graph is on disk before we refetch.
        load()
      }, REFRESH_DEBOUNCE_MS)
    }).then((fn) => {
      if (cancelledRef.current) fn()
      else unlisten = fn
    })

    return () => {
      cancelledRef.current = true
      if (debounceTimer) clearTimeout(debounceTimer)
      if (unlisten) unlisten()
    }
  }, [workspaceRoot, load])

  return { graph, backlinks, loading, error, refresh: load }
}
