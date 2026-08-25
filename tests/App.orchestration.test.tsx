import type { ReactNode } from "react"
import { act, render } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  workspace: {
    workspace: {
      tree: [],
      session: {},
    },
    workspaceRoot: "/workspace",
    changeWorkspace: vi.fn(),
    openNode: vi.fn(),
    openFileDialog: vi.fn(),
    moveNode: vi.fn(),
    recentFiles: [{ path: "/workspace/recent.md" }],
    closeWorkspace: vi.fn(),
  },
  editor: {
    activeFile: {
      id: "/workspace/first.md",
      name: "first.md",
      path: "/workspace/first.md",
      type: "file" as const,
    },
    activeFilePath: "/workspace/first.md" as string | null,
    fileContent: "# First",
    fileVersion: 1,
    openFile: vi.fn(),
    onChange: vi.fn(),
    saveCurrentFile: vi.fn(),
    saveAllFiles: vi.fn(),
    saveAsFile: vi.fn(),
    closeFile: vi.fn(),
    handleExit: vi.fn(),
    openFiles: [],
    activeFileId: "/workspace/first.md",
    switchTab: vi.fn(),
    closeTab: vi.fn(),
    buffersRef: { current: new Map() },
  },
  updateNote: vi.fn(),
  shortcutHandlers: undefined as Record<string, () => void> | undefined,
  workbenchProps: undefined as Record<string, unknown> | undefined,
  topPaneProps: undefined as Record<string, unknown> | undefined,
  leftPaneProps: undefined as Record<string, unknown> | undefined,
  mainPaneProps: undefined as Record<string, unknown> | undefined,
  modalProps: undefined as Record<string, unknown> | undefined,
}))

vi.mock("../src/hooks/useWorkspaceController", () => ({
  useWorkspaceController: () => mocks.workspace,
}))

vi.mock("../src/hooks/useEditorController", () => ({
  useEditorController: () => mocks.editor,
}))

vi.mock("../src/hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: (handlers: Record<string, () => void>) => {
    mocks.shortcutHandlers = handlers
  },
}))

vi.mock("../src/features/settings/useSettings", () => ({
  useSettings: () => ({
    settings: {
      general: { focusModeHidesExplorer: false },
      pomodoro: {},
    },
    updateSettings: vi.fn(),
    resetToDefaults: vi.fn(),
  }),
}))

vi.mock("../src/features/pomodoro/usePomodoro", () => ({
  usePomodoro: () => [{ isRunning: false }, {}],
}))

vi.mock("../src/features/flashcards/useFlashcards", () => ({
  useFlashcards: () => ({}),
}))

vi.mock("../src/features/notes/useNotesSynthesis", () => ({
  useNotesSynthesis: () => ({}),
}))

vi.mock("../src/features/stats/useStudyStats", () => ({
  useStudyStats: () => ({
    data: { sessions: [] },
    recordSession: vi.fn(),
    getDailyAggregates: vi.fn(() => []),
    totalStudyMinutes: 0,
    totalSessions: 0,
    currentStreak: 0,
    avgDailyMinutes: 0,
  }),
}))

vi.mock("../src/features/knowledge/useKnowledgeIndex", () => ({
  useKnowledgeIndex: () => ({
    index: { version: 1, notes: {} },
    updateNote: mocks.updateNote,
    deleteNote: vi.fn(),
    renameNote: vi.fn(),
  }),
}))

vi.mock("../src/features/knowledge/buildGraph", () => ({
  buildGraph: () => ({ nodes: [], edges: [] }),
}))

vi.mock("../src/features/knowledge/useBackendKnowledge", () => ({
  useBackendKnowledge: () => ({
    graph: { nodes: [], edges: [] },
    backlinks: {},
    loading: false,
    error: null,
  }),
}))

vi.mock("../src/state/ThemeContext", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}))

vi.mock("../src/layout/workbench", () => ({
  Workbench: (props: Record<string, unknown>) => {
    mocks.workbenchProps = props
    return (
      <div data-testid="workbench">
        {props.top as ReactNode}
        {props.left as ReactNode}
        {props.main as ReactNode}
        {props.right as ReactNode}
        {props.bottom as ReactNode}
      </div>
    )
  },
}))

vi.mock("../src/layout/panes/TopPane", () => ({
  TopPane: (props: Record<string, unknown>) => {
    mocks.topPaneProps = props
    return <div />
  },
}))

vi.mock("../src/layout/panes/LeftPane", () => ({
  LeftPane: (props: Record<string, unknown>) => {
    mocks.leftPaneProps = props
    return <div />
  },
}))

vi.mock("../src/layout/panes/MainPane", () => ({
  MainPane: (props: Record<string, unknown>) => {
    mocks.mainPaneProps = props
    return <div />
  },
}))

vi.mock("../src/layout/panes/RightPane", () => ({
  RightPane: () => <div />,
}))

vi.mock("../src/layout/panes/BottomPane", () => ({
  BottomPane: () => <div />,
}))

vi.mock("../src/components/StatusBar/ShortcutOverlay", () => ({
  ShortcutOverlay: ({ isOpen }: { isOpen: boolean }) => (
    <div data-testid="shortcut-overlay" data-open={String(isOpen)} />
  ),
}))

vi.mock("../src/components/ThemeEditor/ThemeEditor", () => ({
  ThemeEditor: () => null,
}))

vi.mock("../src/features/settings/SettingsModal", () => ({
  SettingsModal: () => null,
}))

vi.mock("../src/components/Modals/NewItemModal", () => ({
  NewItemModal: (props: Record<string, unknown>) => {
    mocks.modalProps = props
    return <div />
  },
}))

vi.mock("../src/components/SplashScreen/SplashScreen", () => ({
  SplashScreen: () => null,
}))

import App from "../src/App"

function callback<T extends (...args: never[]) => unknown>(
  props: Record<string, unknown> | undefined,
  name: string,
): T {
  return props?.[name] as T
}

describe("App orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.setItem("hibiscus_launched", "1")
    mocks.editor.activeFilePath = "/workspace/first.md"
    mocks.shortcutHandlers = undefined
    mocks.workbenchProps = undefined
    mocks.topPaneProps = undefined
    mocks.leftPaneProps = undefined
    mocks.mainPaneProps = undefined
    mocks.modalProps = undefined
  })

  it("routes a file-open event to both workspace and editor controllers", () => {
    render(<App />)
    const node = {
      id: "/workspace/second.md",
      name: "second.md",
      path: "/workspace/second.md",
      type: "file" as const,
    }

    act(() => callback<(node: typeof node) => void>(mocks.leftPaneProps, "onOpen")(node))

    expect(mocks.workspace.openNode).toHaveBeenCalledWith(node)
    expect(mocks.editor.openFile).toHaveBeenCalledWith(node)
  })

  it("returns to the editor and opens the selected graph node", () => {
    render(<App />)

    act(() => callback<() => void>(mocks.leftPaneProps, "onToggleGraph")())
    expect(mocks.mainPaneProps?.centerView).toBe("graph")

    act(() => callback<(path: string) => void>(mocks.mainPaneProps, "handleGraphNodeClick")(
      "/workspace/linked.md",
    ))

    expect(mocks.mainPaneProps?.centerView).toBe("editor")
    expect(mocks.workspace.openNode).toHaveBeenLastCalledWith({
      id: "/workspace/linked.md",
      name: "linked.md",
      path: "/workspace/linked.md",
      type: "file",
    })
    expect(mocks.editor.openFile).toHaveBeenLastCalledWith(expect.objectContaining({
      path: "/workspace/linked.md",
    }))
  })

  it("opens study tools and search in the right panel", () => {
    render(<App />)

    act(() => callback<(tool: string) => void>(mocks.topPaneProps, "onOpenStudyTool")("pomodoro"))
    expect(mocks.workbenchProps?.showRightPanel).toBe(true)

    act(() => mocks.shortcutHandlers?.onOpenSearch())
    expect(mocks.workbenchProps?.showRightPanel).toBe(true)
  })

  it("toggles panels and the shortcut overlay through the centralized shortcuts", () => {
    const { getByTestId } = render(<App />)

    expect(mocks.leftPaneProps?.visible).toBe(true)
    expect(mocks.workbenchProps?.showRightPanel).toBe(false)
    expect(getByTestId("shortcut-overlay")).toHaveAttribute("data-open", "false")

    act(() => mocks.shortcutHandlers?.onToggleLeftPanel())
    act(() => mocks.shortcutHandlers?.onToggleRightPanel())
    act(() => mocks.shortcutHandlers?.onToggleShortcutOverlay())

    expect(mocks.leftPaneProps?.visible).toBe(false)
    expect(mocks.workbenchProps?.showRightPanel).toBe(true)
    expect(getByTestId("shortcut-overlay")).toHaveAttribute("data-open", "true")
  })

  it("controls the new-item modal and opens a newly-created file", () => {
    render(<App />)

    expect(mocks.modalProps?.open).toBe(false)
    expect(mocks.modalProps?.recentItems).toEqual(["/workspace/recent.md"])

    act(() => callback<() => void>(mocks.topPaneProps, "onNewFolder")())
    expect(mocks.modalProps).toMatchObject({ open: true, mode: "folder" })

    act(() => callback<(path: string, isFile: boolean) => void>(
      mocks.modalProps,
      "onCreated",
    )("/workspace/created.md", true))

    expect(mocks.workspace.openNode).toHaveBeenLastCalledWith(expect.objectContaining({
      name: "created.md",
      path: "/workspace/created.md",
    }))
    expect(mocks.editor.openFile).toHaveBeenLastCalledWith(expect.objectContaining({
      path: "/workspace/created.md",
    }))

    act(() => callback<() => void>(mocks.modalProps, "onClose")())
    expect(mocks.modalProps).toMatchObject({ open: false, mode: "file" })
  })

  it("keeps markdown view mode independently for each file", () => {
    const { rerender } = render(<App />)

    expect(mocks.mainPaneProps?.markdownViewMode).toBe("live-preview")
    act(() => callback<() => void>(mocks.mainPaneProps, "onToggleMarkdownViewMode")())
    expect(mocks.mainPaneProps?.markdownViewMode).toBe("source")

    mocks.editor.activeFilePath = "/workspace/second.md"
    rerender(<App />)
    expect(mocks.mainPaneProps?.markdownViewMode).toBe("live-preview")

    mocks.editor.activeFilePath = "/workspace/first.md"
    rerender(<App />)
    expect(mocks.mainPaneProps?.markdownViewMode).toBe("source")
  })
})
