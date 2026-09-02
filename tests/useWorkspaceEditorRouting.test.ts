import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWorkspaceEditorRouting } from "../src/hooks/useWorkspaceEditorRouting"

const handlers = {
  openNode: vi.fn(),
  openFileDialog: vi.fn(),
  closeWorkspace: vi.fn(),
  openFile: vi.fn(),
  onChange: vi.fn(),
  saveAsFile: vi.fn(),
  closeFile: vi.fn(),
  handleEditorExit: vi.fn(),
  updateNote: vi.fn(),
  setCenterView: vi.fn(),
  setCursorPosition: vi.fn(),
}

function renderRouting(activeFilePath: string | null = "/workspace/active.md") {
  return renderHook(() => useWorkspaceEditorRouting({
    activeFilePath,
    ...handlers,
  }))
}

describe("useWorkspaceEditorRouting", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("routes file opens through workspace and editor and resets the cursor", () => {
    const { result } = renderRouting()
    const node = {
      id: "/workspace/note.md",
      name: "note.md",
      path: "/workspace/note.md",
      type: "file" as const,
    }

    act(() => result.current.handleFileOpen(node))

    expect(handlers.openNode).toHaveBeenCalledWith(node)
    expect(handlers.openFile).toHaveBeenCalledWith(node)
    expect(handlers.setCursorPosition).toHaveBeenCalledWith({ line: 1, column: 1 })
  })

  it("builds file nodes for path and graph navigation", () => {
    const { result } = renderRouting()

    act(() => result.current.handleGraphNodeClick("/workspace/folder/linked.md"))

    expect(handlers.setCenterView).toHaveBeenCalledWith("editor")
    expect(handlers.openNode).toHaveBeenCalledWith({
      id: "/workspace/folder/linked.md",
      name: "linked.md",
      path: "/workspace/folder/linked.md",
      type: "file",
    })
  })

  it("forwards editor changes to the active knowledge note", () => {
    const { result } = renderRouting()

    act(() => result.current.handleEditorChange("updated"))

    expect(handlers.onChange).toHaveBeenCalledWith("updated")
    expect(handlers.updateNote).toHaveBeenCalledWith("/workspace/active.md", "updated")
  })

  it("does not update the knowledge index without an active file", () => {
    const { result } = renderRouting(null)

    act(() => result.current.handleEditorChange("updated"))

    expect(handlers.onChange).toHaveBeenCalledWith("updated")
    expect(handlers.updateNote).not.toHaveBeenCalled()
  })

  it("opens files selected from the native dialog", async () => {
    handlers.openFileDialog.mockResolvedValue("/workspace/dialog.md")
    const { result } = renderRouting()

    await act(() => result.current.handleOpenFile())

    expect(handlers.openFile).toHaveBeenCalledWith(expect.objectContaining({
      name: "dialog.md",
      path: "/workspace/dialog.md",
    }))
  })

  it("opens newly created files but ignores folders", () => {
    const { result } = renderRouting()

    act(() => result.current.handleItemCreated("/workspace/folder", false))
    expect(handlers.openFile).not.toHaveBeenCalled()

    act(() => result.current.handleItemCreated("/workspace/created.md", true))
    expect(handlers.openFile).toHaveBeenCalledWith(expect.objectContaining({
      path: "/workspace/created.md",
    }))
  })

  it("closes the workspace only when editor exit is confirmed", async () => {
    handlers.handleEditorExit.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const { result } = renderRouting()

    await act(() => result.current.handleAppExit())
    expect(handlers.closeWorkspace).not.toHaveBeenCalled()

    await act(() => result.current.handleAppExit())
    expect(handlers.closeWorkspace).toHaveBeenCalledTimes(1)
  })

  it("delegates save-as, close-file, and close-folder actions unchanged", async () => {
    const { result } = renderRouting()

    await act(() => result.current.handleSaveAs())
    await act(() => result.current.handleCloseFile())
    act(() => result.current.handleCloseFolder())

    expect(handlers.saveAsFile).toHaveBeenCalledTimes(1)
    expect(handlers.closeFile).toHaveBeenCalledTimes(1)
    expect(handlers.closeWorkspace).toHaveBeenCalledTimes(1)
  })
})
