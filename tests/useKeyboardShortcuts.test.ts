import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useKeyboardShortcuts } from "../src/hooks/useKeyboardShortcuts"

describe("useKeyboardShortcuts", () => {
  it("registers one listener and always calls the latest handlers", () => {
    const addListener = vi.spyOn(window, "addEventListener")
    const removeListener = vi.spyOn(window, "removeEventListener")
    const firstToggle = vi.fn()
    const latestToggle = vi.fn()

    const { rerender, unmount } = renderHook(
      ({ onToggleLeftPanel }) => useKeyboardShortcuts({ onToggleLeftPanel }),
      { initialProps: { onToggleLeftPanel: firstToggle } },
    )

    rerender({ onToggleLeftPanel: latestToggle })

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }))
    })

    expect(firstToggle).not.toHaveBeenCalled()
    expect(latestToggle).toHaveBeenCalledTimes(1)
    expect(addListener).toHaveBeenCalledTimes(1)

    unmount()
    expect(removeListener).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
      true,
    )

    addListener.mockRestore()
    removeListener.mockRestore()
  })
})
