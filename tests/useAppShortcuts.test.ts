import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const keyboard = vi.hoisted(() => ({
  handlers: undefined as Record<string, () => void> | undefined,
}))

vi.mock("../src/hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: (handlers: Record<string, () => void>) => {
    keyboard.handlers = handlers
  },
}))

import { useAppShortcuts } from "../src/hooks/useAppShortcuts"

const actions = {
  changeWorkspace: vi.fn(),
  toggleLeftPanel: vi.fn(),
  toggleRightPanel: vi.fn(),
  toggleShortcutOverlay: vi.fn(),
  toggleGraphView: vi.fn(),
  setShowRightPanel: vi.fn(),
  setActiveStudyPanel: vi.fn(),
  toggleFocusMode: vi.fn(),
  setSettingsOpen: vi.fn(),
  setRightPanelView: vi.fn(),
  toggleMarkdownViewMode: vi.fn(),
}

describe("useAppShortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    keyboard.handlers = undefined
  })

  it("opens study tools in the visible right panel", () => {
    const { result } = renderHook(() => useAppShortcuts(actions))

    act(() => result.current.openStudyTool("stats"))

    expect(actions.setActiveStudyPanel).toHaveBeenCalledWith("stats")
    expect(actions.setShowRightPanel).toHaveBeenCalledWith(true)
  })

  it("provides named settings actions", () => {
    const { result } = renderHook(() => useAppShortcuts(actions))

    act(() => result.current.openSettings())
    act(() => result.current.closeSettings())

    expect(actions.setSettingsOpen).toHaveBeenNthCalledWith(1, true)
    expect(actions.setSettingsOpen).toHaveBeenNthCalledWith(2, false)
  })

  it("wires search, pomodoro, and layout actions to the central shortcut system", () => {
    renderHook(() => useAppShortcuts(actions))

    act(() => keyboard.handlers?.onOpenSearch())
    expect(actions.setShowRightPanel).toHaveBeenCalledWith(true)
    expect(actions.setRightPanelView).toHaveBeenCalledWith("search")

    act(() => keyboard.handlers?.onOpenPomodoro())
    expect(actions.setActiveStudyPanel).toHaveBeenCalledWith("pomodoro")

    act(() => keyboard.handlers?.onToggleShortcutOverlay())
    expect(actions.toggleShortcutOverlay).toHaveBeenCalledTimes(1)
  })
})
