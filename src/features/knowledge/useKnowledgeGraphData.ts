import { useMemo } from "react"
import type { Node } from "../../types/workspace"
import { buildGraph, type GraphData } from "./buildGraph"
import { useBackendKnowledge, type BackendKnowledge } from "./useBackendKnowledge"
import { useKnowledgeIndex } from "./useKnowledgeIndex"

type BuffersRef = Parameters<typeof useKnowledgeIndex>[1]
type KnowledgeIndexController = ReturnType<typeof useKnowledgeIndex>

interface KnowledgeGraphData {
  graph: GraphData
  index: KnowledgeIndexController["index"]
  updateNote: KnowledgeIndexController["updateNote"]
  backlinks: BackendKnowledge["backlinks"]
  loading: BackendKnowledge["loading"]
  error: BackendKnowledge["error"]
}

export function selectKnowledgeGraph(
  backendGraph: GraphData | null,
  fallbackGraph: GraphData,
): GraphData {
  return backendGraph && backendGraph.nodes.length > 0
    ? backendGraph
    : fallbackGraph
}

export function useKnowledgeGraphData(
  workspaceRoot: string | null,
  files: Node[],
  buffersRef: BuffersRef,
): KnowledgeGraphData {
  const knowledgeIndex = useKnowledgeIndex(files, buffersRef)
  const backendKnowledge = useBackendKnowledge(workspaceRoot)

  const fallbackGraph = useMemo(
    () => buildGraph(knowledgeIndex.index),
    [knowledgeIndex.index.version],
  )

  const graph = useMemo(
    () => selectKnowledgeGraph(backendKnowledge.graph, fallbackGraph),
    [backendKnowledge.graph, fallbackGraph],
  )

  return {
    graph,
    index: knowledgeIndex.index,
    updateNote: knowledgeIndex.updateNote,
    backlinks: backendKnowledge.backlinks,
    loading: backendKnowledge.loading,
    error: backendKnowledge.error,
  }
}
