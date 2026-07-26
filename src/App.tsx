/**
 * ============================================================================
 * App Component - Main Application Entry Point
 * ============================================================================
 * 
 * The root component that orchestrates the entire Hibiscus workspace editor.
 * 
 * ARCHITECTURE:
 * - Uses Workbench layout for IDE-like panels (top, left, main, right, bottom)
 * - Workspace state managed by useWorkspaceController hook
 * - Editor state managed by useEditorController hook
 * - Study tools managed by feature hooks (pomodoro, flashcards, etc.)
 * - Components communicate through callbacks and shared state
 * 
 * PROVIDERS:
 * - ThemeProvider: Theme system with editor adapter
 * - StudyProvider: Focus mode + study panel routing
 * 
 * STYLING:
 * - Uses App.css for main content styling
 * - Child components have their own CSS modules
 * - Design tokens from theme.css ensure consistency
 * ============================================================================
 */

import { useState, useCallback, useMemo } from "react"
import { SplashScreen } from "./components/SplashScreen/SplashScreen"
import { Workbench } from "./layout/workbench"
import { CursorPosition } from "./components/Editor/EditorView"
import { ShortcutOverlay } from "./components/StatusBar/ShortcutOverlay"
import { ThemeEditor } from "./components/ThemeEditor/ThemeEditor"
import { ThemeProvider } from "./state/ThemeContext"
import { NewItemModal, NewItemModalMode } from "./components/Modals/NewItemModal"

// Study tools imports
import { StudyProvider, useStudy } from "./features/shared/StudyContext"
import { SettingsModal } from "./features/settings/SettingsModal"
import { useSettings } from "./features/settings/useSettings"
import { usePomodoro } from "./features/pomodoro/usePomodoro"
import { useFlashcards } from "./features/flashcards/useFlashcards"
import { useNotesSynthesis } from "./features/notes/useNotesSynthesis"
import { useStudyStats } from "./features/stats/useStudyStats"

import { useWorkspaceController } from "./hooks/useWorkspaceController"
import { useEditorController } from "./hooks/useEditorController"
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts"

import versionInfo from "../version.json"

export const APP_NAME = versionInfo.name;
export const APP_VERSION = versionInfo.version;

import "./App.css"

// Knowledge system
import { useKnowledgeIndex } from "./features/knowledge/useKnowledgeIndex"
import { buildGraph } from "./features/knowledge/buildGraph"

// Layout Panes
import { TopPane } from "./layout/panes/TopPane"
import { LeftPane } from "./layout/panes/LeftPane"
import { MainPane } from "./layout/panes/MainPane"
import { RightPane } from "./layout/panes/RightPane"
import { BottomPane } from "./layout/panes/BottomPane"

/**
 * Inner app component that has access to StudyContext.
 * This separation is needed because useStudy() requires StudyProvider
 * to be mounted above it in the tree.
 */
function AppInner() {
  // ============================================================================
  // MODAL STATE
  // New file/folder creation modal
  // ============================================================================
  const [newItemModal, setNewItemModal] = useState<{
    open: boolean
    mode: NewItemModalMode
  }>({
    open: false,
    mode: "file"
  })

  // ============================================================================
  // WORKSPACE STATE
  // Tree structure, root path, and navigation
  // ============================================================================
  const {
    workspace,
    workspaceRoot,
    changeWorkspace,
    openNode,
    openFileDialog,
    moveNode,
    recentFiles, // Provide this explicitly
    closeWorkspace,
  } = useWorkspaceController()

  // ============================================================================
  // EDITOR STATE
  // Active file, content, save handling, and multi-file tab management
  // ============================================================================
  const {
    activeFile,
    activeFilePath,
    fileContent,
    fileVersion,
    openFile,
    onChange,
    saveCurrentFile,
    saveAllFiles,
    saveAsFile,
    closeFile,
    handleExit: handleEditorExit,
    // Multi-file tab interface
    openFiles,
    activeFileId,
    switchTab,
    closeTab,
    // Buffer ref (for knowledge index)
    buffersRef,
  } = useEditorController(workspaceRoot)

  // ============================================================================
  // MARKDOWN VIEW MODE (per-file)
  // Each .md file remembers its own mode: "live-preview" or "source".
  // Non-markdown files are unaffected.
  // NOTE: Must be declared AFTER useEditorController which defines activeFilePath.
  // ============================================================================
  const [markdownViewModes, setMarkdownViewModes] = useState<Record<string, "live-preview" | "source">>({})

  /**
   * Derive the current markdown view mode for the active file.
   * Defaults to "live-preview" for .md files that haven't been toggled yet.
   */
  const activeMarkdownViewMode: "live-preview" | "source" =
    activeFilePath && activeFilePath.toLowerCase().endsWith(".md")
      ? (markdownViewModes[activeFilePath] ?? "live-preview")
      : "source" // non-md files are always "source" (plain Monaco)

  /**
   * Toggle the markdown view mode for the currently active file.
   * Only operates on .md files; silently ignored otherwise.
   */
  const toggleMarkdownViewMode = useCallback(() => {
    if (!activeFilePath || !activeFilePath.toLowerCase().endsWith(".md")) return
    setMarkdownViewModes((prev) => ({
      ...prev,
      [activeFilePath]: (prev[activeFilePath] ?? "live-preview") === "live-preview" ? "source" : "live-preview",
    }))
  }, [activeFilePath])

  // ============================================================================
  // STUDY TOOLS STATE
  // Shared context + individual feature hooks
  // ============================================================================
  const {
    focusMode,
    setFocusMode,
    toggleFocusMode,
    setActiveStudyPanel,
    isSettingsOpen,
    setSettingsOpen,
  } = useStudy()

  // Settings hook
  const { settings, updateSettings, resetToDefaults } = useSettings(workspaceRoot)

  // Study statistics hook
  const studyStats = useStudyStats(workspaceRoot)

  // Pomodoro hook (wired to focus mode + stats recording)
  const [pomodoroState, pomodoroActions] = usePomodoro({
    settings: settings.pomodoro,
    onFocusMode: setFocusMode,
    onSessionComplete: (durationSeconds) => {
      studyStats.recordSession({
        date: new Date().toISOString().split("T")[0],
        startTime: new Date().toISOString(),
        duration: durationSeconds,
        type: "pomodoro",
        completedFull: true,
      })
    },
  })

  // Flashcards hook
  const flashcards = useFlashcards(workspaceRoot)

  // Notes synthesis hook
  const notes = useNotesSynthesis(workspaceRoot)

  // ============================================================================
  // KNOWLEDGE INDEX
  // Tracks [[links]], #tags, and backlinks across workspace notes
  // ============================================================================
  const {
    index: knowledgeIndex,
    updateNote,
    // Available for wiring to tree mutation events (file delete / rename)
    deleteNote: _deleteNote,
    renameNote: _renameNote,
  } = useKnowledgeIndex(
    workspace.tree,
    buffersRef
  )

  // Memoize graph data based on index version to avoid recalculation
  const knowledgeGraph = useMemo(
    () => buildGraph(knowledgeIndex),
    [knowledgeIndex.version]
  )

  // ============================================================================
  // PANEL VISIBILITY STATE
  // Controls which panels are visible in the layout
  // ============================================================================
  const [showLeftPanel, setShowLeftPanel] = useState(true)
  const [showRightPanel, setShowRightPanel] = useState(false)
  const [showShortcutOverlay, setShowShortcutOverlay] = useState(false)

  // ============================================================================
  // CENTER VIEW MODE
  // Toggle between editor and knowledge graph in the center panel
  // ============================================================================
  const [centerView, setCenterView] = useState<"editor" | "graph">("editor")

  const toggleGraphView = useCallback(() => {
    setCenterView((prev) => (prev === "editor" ? "graph" : "editor"))
  }, [])

  // ============================================================================
  // CURSOR POSITION STATE
  // Tracks current line/column for status bar display
  // ============================================================================
  const [cursorPosition, setCursorPosition] = useState<CursorPosition>({
    line: 1,
    column: 1,
  })

  /**
   * Handle file open events from the tree view
   * Updates both workspace session (for persistence) and editor state
   */
  const handleFileOpen = (node: Parameters<typeof openNode>[0]) => {
    openNode(node)
    openFile(node)
    // Reset cursor position when opening new file
    setCursorPosition({ line: 1, column: 1 })
  }

  /**
   * Handle editor content changes — forward to both buffer system
   * and knowledge index for incremental link/tag parsing.
   */
  const handleEditorChange = useCallback(
    (value: string) => {
      onChange(value)
      if (activeFilePath) {
        updateNote(activeFilePath, value)
      }
    },
    [onChange, activeFilePath, updateNote]
  )

  /**
   * Toggle left panel (Explorer) visibility
   */
  const toggleLeftPanel = useCallback(() => {
    setShowLeftPanel((prev) => !prev)
  }, [])

  /**
   * Toggle right panel (Calendar/Study Tools) visibility
   */
  const toggleRightPanel = useCallback(() => {
    setShowRightPanel((prev) => !prev)
  }, [])

  /**
   * Open file by path string (for Calendar linked files)
   */
  const openFileByPath = useCallback((filePath: string, _line?: number) => {
    const name = filePath.split(/[/\\]/).pop() || filePath
    handleFileOpen({
      id: filePath,
      name,
      path: filePath,
      type: "file"
    })
  }, [handleFileOpen])

  /**
   * Open file from graph node click — switches to editor and opens file
   */
  const handleGraphNodeClick = useCallback((filePath: string) => {
    setCenterView("editor")
    openFileByPath(filePath)
  }, [openFileByPath])

  /**
   * Handle file menu actions
   */
  const handleNewFile = useCallback(() => {
    if (!workspaceRoot) {
      // TODO: Show proper notification instead of alert
      console.warn("Please open a workspace first")
      return
    }
    
    setNewItemModal({ open: true, mode: "file" })
  }, [workspaceRoot])

  const handleNewFolder = useCallback(() => {
    if (!workspaceRoot) {
      // TODO: Show proper notification instead of alert
      console.warn("Please open a workspace first")
      return
    }
    
    setNewItemModal({ open: true, mode: "folder" })
  }, [workspaceRoot])

  /**
   * Handle modal close
   */
  const handleModalClose = useCallback(() => {
    setNewItemModal({ open: false, mode: "file" })
  }, [])

  /**
   * Handle successful item creation from the modal.
   * If a file was created, open it in the editor.
   */
  const handleItemCreated = useCallback((absolutePath: string, isFile: boolean) => {
    if (isFile) {
      const name = absolutePath.split(/[/\\]/).pop() || absolutePath
      handleFileOpen({
        id: absolutePath,
        name,
        path: absolutePath,
        type: "file"
      })
    }
  }, [handleFileOpen])

  // ============================================================================
  // KEYBOARD SHORTCUTS
  // Handle all global keyboard shortcuts using the centralized hook.
  // IMPORTANT: Only ONE useKeyboardShortcuts call is allowed. Multiple calls
  // register duplicate event listeners, causing shortcuts to fire twice or
  // interfere with each other (e.g., Ctrl+M calling preventDefault but not
  // triggering the handler if onToggleMarkdownPreview is missing).
  // ============================================================================
  const { setRightPanelView } = useStudy()

  const handleOpenFile = useCallback(async () => {
    const filePath = await openFileDialog()
    if (filePath) {
      const name = filePath.split(/[/\\]/).pop() || filePath
      handleFileOpen({
        id: filePath,
        name,
        path: filePath,
        type: "file"
      })
    }
  }, [openFileDialog, handleFileOpen])

  const handleSaveAs = useCallback(async () => {
    await saveAsFile()
  }, [saveAsFile])

  const handleCloseFile = useCallback(async () => {
    await closeFile()
  }, [closeFile])

  const handleCloseFolder = useCallback(() => {
    closeWorkspace()
  }, [closeWorkspace])

  const handleAppExit = useCallback(async () => {
    const shouldExit = await handleEditorExit()
    if (shouldExit) {
      // In a real app, this would close the application
      // For now, we'll just close the workspace
      closeWorkspace()
    }
  }, [handleEditorExit, closeWorkspace])

  /**
   * Open a study tool panel in the right sidebar.
   * Also ensures the right panel is visible.
   */
  const openStudyTool = useCallback(
    (tool: "pomodoro" | "flashcards" | "notes" | "stats") => {
      setActiveStudyPanel(tool)
      setShowRightPanel(true)
    },
    [setActiveStudyPanel]
  )

  useKeyboardShortcuts({
    onOpenFolder: changeWorkspace,
    onToggleLeftPanel: toggleLeftPanel,
    onToggleRightPanel: toggleRightPanel,
    onToggleShortcutOverlay: () => setShowShortcutOverlay((prev) => !prev),
    onOpenPomodoro: () => openStudyTool("pomodoro"),
    onToggleFocusMode: toggleFocusMode,
    onOpenSettings: () => setSettingsOpen(true),
    onOpenSearch: () => {
      setShowRightPanel(true)
      setRightPanelView("search")
    },
    onToggleMarkdownPreview: toggleMarkdownViewMode,
    onToggleGraphView: toggleGraphView,
  })

  // ============================================================================
  // STATS DATA (computed once for StatsPanel)
  // ============================================================================
  const statsData = {
    totalStudyMinutes: studyStats.totalStudyMinutes,
    totalSessions: studyStats.totalSessions,
    currentStreak: studyStats.currentStreak,
    avgDailyMinutes: studyStats.avgDailyMinutes,
    weeklyData: studyStats.getDailyAggregates(7),
    recentSessions: studyStats.data.sessions,
  }

  return (
    <>
      <Workbench
        top={
          <TopPane
            workspaceRoot={workspaceRoot}
            onChangeWorkspace={changeWorkspace}
            onToggleLeftPanel={toggleLeftPanel}
            onToggleRightPanel={toggleRightPanel}
            showLeftPanel={showLeftPanel}
            showRightPanel={showRightPanel}
            onSaveCurrentFile={saveCurrentFile}
            onSaveAs={handleSaveAs}
            onSaveAllFiles={saveAllFiles}
            onCloseFile={handleCloseFile}
            onOpenFile={handleOpenFile}
            onNewFile={handleNewFile}
            onNewFolder={handleNewFolder}
            onCloseFolder={handleCloseFolder}
            onAppExit={handleAppExit}
            onOpenStudyTool={openStudyTool}
            onToggleFocusMode={toggleFocusMode}
            focusMode={focusMode}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        }

        /* ----------------------------------------------------------------
         * LEFT PANEL - File Tree
         * Displays the workspace file structure for navigation.
         * Hidden during focus mode when setting is enabled.
         * ---------------------------------------------------------------- */
        left={
          <LeftPane
            visible={showLeftPanel}
            hiddenByFocusMode={!!(focusMode && settings.general.focusModeHidesExplorer)}
            tree={workspace.tree}
            activeNodeId={workspace.session?.active_node}
            onOpen={handleFileOpen}
            onNewFile={handleNewFile}
            onNewFolder={handleNewFolder}
            onMoveNode={moveNode}
            onToggleGraph={toggleGraphView}
          />
        }

        /* ----------------------------------------------------------------
         * MAIN PANEL - Editor Area
         * Monaco editor when a file is selected, placeholder otherwise
         * ---------------------------------------------------------------- */
        main={
          <MainPane
            centerView={centerView}
            setCenterView={setCenterView}
            knowledgeGraph={knowledgeGraph}
            activeFile={activeFile}
            activeFilePath={activeFilePath}
            activeFileId={activeFileId}
            fileContent={fileContent}
            fileVersion={fileVersion}
            openFiles={openFiles}
            markdownViewMode={activeMarkdownViewMode}
            onToggleMarkdownViewMode={toggleMarkdownViewMode}
            handleGraphNodeClick={handleGraphNodeClick}
            switchTab={switchTab}
            closeTab={closeTab}
            handleFileOpen={handleFileOpen}
            handleEditorChange={handleEditorChange}
            setCursorPosition={setCursorPosition}
            saveCurrentFile={saveCurrentFile}
          />
        }
        right={
          <RightPane
            workspaceRoot={workspaceRoot}
            onOpenFile={openFileByPath}
            pomodoroState={pomodoroState}
            pomodoroActions={pomodoroActions}
            flashcards={flashcards}
            notes={notes}
            statsData={statsData}
            knowledgeGraph={knowledgeGraph}
            knowledgeIndex={knowledgeIndex}
            activeFilePath={activeFilePath}
          />
        }
        showRightPanel={showRightPanel}

        /* ----------------------------------------------------------------
         * BOTTOM PANEL - Status Bar
         * Displays status info, cursor position, and layout controls
         * ---------------------------------------------------------------- */
        bottom={
          <BottomPane
            workspaceRoot={workspaceRoot}
            focusMode={focusMode}
            activeFile={activeFile}
            cursorPosition={cursorPosition}
            pomodoroState={pomodoroState}
            showLeftPanel={showLeftPanel}
            showRightPanel={showRightPanel}
            appName={APP_NAME}
            appVersion={APP_VERSION}
            openStudyTool={openStudyTool}
            toggleLeftPanel={toggleLeftPanel}
            toggleRightPanel={toggleRightPanel}
          />
        }
      />
      <ShortcutOverlay
        isOpen={showShortcutOverlay}
        onClose={() => setShowShortcutOverlay(false)}
      />
      {/* Theme Editor Modal — controlled by ThemeContext */}
      <ThemeEditor />
      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onUpdate={updateSettings}
        onReset={resetToDefaults}
      />
      {/* New Item Modal (keyboard-centric, with suggestions) */}
      <NewItemModal
        open={newItemModal.open}
        mode={newItemModal.mode}
        onClose={handleModalClose}
        workspaceRoot={workspaceRoot}
        tree={workspace.tree}
        recentItems={recentFiles.map(f => f.path)}
        onCreated={handleItemCreated}
      />
    </>
  )
}

/**
 * Root App component — wraps AppInner with providers.
 */
export default function App() {
  const { workspaceRoot } = useWorkspaceController()

  // Cold-start gate — sessionStorage resets on process exit, so this
  // shows exactly once per OS-level launch, not on hot reloads.
  const isFirstLoad = !sessionStorage.getItem('hibiscus_launched');
  if (isFirstLoad) sessionStorage.setItem('hibiscus_launched', '1');

  const [splashVisible, setSplashVisible] = useState(isFirstLoad);
  const [splashExiting, setSplashExiting] = useState(false);

  const handleSplashDone = useCallback(() => {
    setSplashExiting(true);
    setTimeout(() => setSplashVisible(false), 350); // matches CSS transition duration
  }, []);

  return (
    <>
      {splashVisible && (
        <SplashScreen
          onDone={handleSplashDone}
          exiting={splashExiting}
        />
      )}
      <ThemeProvider workspaceRoot={workspaceRoot}>
        <StudyProvider>
          <AppInner />
        </StudyProvider>
      </ThemeProvider>
    </>
  )
}
