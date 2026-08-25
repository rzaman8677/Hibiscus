import { useCallback } from "react"
import type { StudyContextType, StudyPanel } from "../features/shared/StudyContext"
import type { useAppLayout } from "./useAppLayout"
import type { useWorkspaceController } from "./useWorkspaceController"
import { useKeyboardShortcuts } from "./useKeyboardShortcuts"

type AppLayout = ReturnType<typeof useAppLayout>
type WorkspaceController = ReturnType<typeof useWorkspaceController>
export type StudyTool = Extract<StudyPanel, "pomodoro" | "flashcards" | "notes" | "stats">

interface AppShortcutsOptions {
  changeWorkspace: WorkspaceController["changeWorkspace"]
  toggleLeftPanel: AppLayout["toggleLeftPanel"]
  toggleRightPanel: AppLayout["toggleRightPanel"]
  toggleShortcutOverlay: AppLayout["toggleShortcutOverlay"]
  toggleGraphView: AppLayout["toggleGraphView"]
  setShowRightPanel: AppLayout["setShowRightPanel"]
  setActiveStudyPanel: StudyContextType["setActiveStudyPanel"]
  toggleFocusMode: StudyContextType["toggleFocusMode"]
  setSettingsOpen: StudyContextType["setSettingsOpen"]
  setRightPanelView: StudyContextType["setRightPanelView"]
  toggleMarkdownViewMode: () => void
}

interface AppShortcutActions {
  openStudyTool: (tool: StudyTool) => void
  openSettings: () => void
  closeSettings: () => void
}

export function useAppShortcuts({
  changeWorkspace,
  toggleLeftPanel,
  toggleRightPanel,
  toggleShortcutOverlay,
  toggleGraphView,
  setShowRightPanel,
  setActiveStudyPanel,
  toggleFocusMode,
  setSettingsOpen,
  setRightPanelView,
  toggleMarkdownViewMode,
}: AppShortcutsOptions): AppShortcutActions {
  const openStudyTool = useCallback((tool: StudyTool) => {
    setActiveStudyPanel(tool)
    setShowRightPanel(true)
  }, [setActiveStudyPanel, setShowRightPanel])

  const openSettings = useCallback(() => {
    setSettingsOpen(true)
  }, [setSettingsOpen])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
  }, [setSettingsOpen])

  const openSearch = useCallback(() => {
    setShowRightPanel(true)
    setRightPanelView("search")
  }, [setShowRightPanel, setRightPanelView])

  useKeyboardShortcuts({
    onOpenFolder: changeWorkspace,
    onToggleLeftPanel: toggleLeftPanel,
    onToggleRightPanel: toggleRightPanel,
    onToggleShortcutOverlay: toggleShortcutOverlay,
    onOpenPomodoro: () => openStudyTool("pomodoro"),
    onToggleFocusMode: toggleFocusMode,
    onOpenSettings: openSettings,
    onOpenSearch: openSearch,
    onToggleMarkdownPreview: toggleMarkdownViewMode,
    onToggleGraphView: toggleGraphView,
  })

  return { openStudyTool, openSettings, closeSettings }
}
