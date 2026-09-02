import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useMarkdownViewMode } from "../src/features/editor/useMarkdownViewMode"

describe("useMarkdownViewMode", () => {
  it("defaults markdown files to live preview and other files to source", () => {
    const { result, rerender } = renderHook(
      ({ path }: { path: string | null }) => useMarkdownViewMode(path),
      { initialProps: { path: "/workspace/note.md" as string | null } },
    )

    expect(result.current.activeMode).toBe("live-preview")

    rerender({ path: "/workspace/code.ts" })
    expect(result.current.activeMode).toBe("source")
  })

  it("remembers the selected mode independently for each markdown file", () => {
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useMarkdownViewMode(path),
      { initialProps: { path: "/workspace/first.md" } },
    )

    act(() => result.current.toggleActiveMode())
    expect(result.current.activeMode).toBe("source")

    rerender({ path: "/workspace/second.md" })
    expect(result.current.activeMode).toBe("live-preview")

    rerender({ path: "/workspace/first.md" })
    expect(result.current.activeMode).toBe("source")
  })

  it("ignores toggles for non-markdown files", () => {
    const { result } = renderHook(() => useMarkdownViewMode("/workspace/code.ts"))

    act(() => result.current.toggleActiveMode())

    expect(result.current.activeMode).toBe("source")
  })
})
