import { describe, expect, it } from "vitest"
import { selectKnowledgeGraph } from "../src/features/knowledge/useKnowledgeGraphData"

const fallbackGraph = {
  nodes: [{ id: "fallback", label: "Fallback" }],
  edges: [],
}

describe("selectKnowledgeGraph", () => {
  it("uses the backend graph when it contains nodes", () => {
    const backendGraph = {
      nodes: [{ id: "backend", label: "Backend" }],
      edges: [],
    }

    expect(selectKnowledgeGraph(backendGraph, fallbackGraph)).toBe(backendGraph)
  })

  it("falls back when the backend graph is absent or empty", () => {
    expect(selectKnowledgeGraph(null, fallbackGraph)).toBe(fallbackGraph)
    expect(selectKnowledgeGraph({ nodes: [], edges: [] }, fallbackGraph)).toBe(fallbackGraph)
  })
})
