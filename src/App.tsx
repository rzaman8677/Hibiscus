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

import { useState, useCallback } from "react"
import { SplashScreen } from "./components/SplashScreen/SplashScreen"
import { Workbench } from "./layout/workbench"
import { ShortcutOverlay } from "./components/StatusBar/ShortcutOverlay"
import { ThemeEditor } from "./components/ThemeEditor/ThemeEditor"
import { ThemeProvider } from "./state/ThemeContext"
import { NewItemModal } from "./components/Modals/NewItemModal"

// Study tools imports
import { StudyProvider, useStudy } from "./features/shared/StudyContext"
import { SettingsModal } from "./features/settings/SettingsModal"
import { useStudyTools } from "./features/study/useStudyTools"

import { useWorkspaceController } from "./hooks/useWorkspaceController"
import { useEditorController } from "./hooks/useEditorController"
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts"
import { useAppLayout } from "./hooks/useAppLayout"
import { useWorkspaceEditorRouting } from "./hooks/useWorkspaceEditorRouting"

import versionInfo from "../version.json"

export const APP_NAME = versionInfo.name;
export const APP_VERSION = versionInfo.version;

import "./App.css"

import { useMarkdownViewMode } from "./features/editor/useMarkdownViewMode"
import { useKnowledgeGraphData } from "./features/knowledge/useKnowledgeGraphData"
import { useNewItemModal } from "./features/newitem"

// Layout Panes
import { TopPane } from "./layout/panes/TopPane"
import { LeftPane } from "./layout/panes/LeftPane"
import { MainPane } from "./layout/panes/MainPane"
import { RightPane } from "./layout/panes/RightPane"
import { BottomPane } from "./layout/panes/BottomPane"

type WorkspaceController = ReturnType<typeof useWorkspaceController>

interface AppInnerProps {
  workspaceController: WorkspaceController
}

/**
 * Inner app component that has access to StudyContext.
 * This separation is needed because useStudy() requires StudyProvider
 * to be mounted above it in the tree.
 */
function AppInner({ workspaceController }: AppInnerProps) {
  const {
    showLeftPanel,
    showRightPanel,
    showShortcutOverlay,
    centerView,
    cursorPosition,
    setShowRightPanel,
    setShowShortcutOverlay,
    setCenterView,
    setCursorPosition,
    toggleLeftPanel,
    toggleRightPanel,
    toggleGraphView,
  } = useAppLayout()

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
  } = workspaceController

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

  const {
    activeMode: activeMarkdownViewMode,
    toggleActiveMode: toggleMarkdownViewMode,
  } = useMarkdownViewMode(activeFilePath)

  // ============================================================================
  // STUDY TOOLS STATE
  // Shared context + individual feature hooks
  // ============================================================================
  const {
    focusMode,
    setFocusMode,
    toggleFocusMode,
    setActiveStudyPanel,
    setRightPanelView,
    isSettingsOpen,
    setSettingsOpen,
  } = useStudy()

  const {
    settings,
    updateSettings,
    resetToDefaults,
    pomodoroState,
    pomodoroActions,
    flashcards,
    notes,
    statsData,
  } = useStudyTools(workspaceRoot, setFocusMode)

  const {
    graph: knowledgeGraph,
    index: knowledgeIndex,
    updateNote,
    backlinks: backendBacklinks,
    loading: knowledgeLoading,
    error: knowledgeError,
  } = useKnowledgeGraphData(
    workspaceRoot,
    workspace.tree,
    buffersRef,
  )

  const {
    modal: newItemModal,
    openFileModal: handleNewFile,
    openFolderModal: handleNewFolder,
    closeModal: handleModalClose,
  } = useNewItemModal(workspaceRoot)

  const {
    handleFileOpen,
    openFileByPath,
    handleGraphNodeClick,
    handleEditorChange,
    handleItemCreated,
    handleOpenFile,
    handleSaveAs,
    handleCloseFile,
    handleCloseFolder,
    handleAppExit,
  } = useWorkspaceEditorRouting({
    activeFilePath,
    openNode,
    openFileDialog,
    closeWorkspace,
    openFile,
    onChange,
    saveAsFile,
    closeFile,
    handleEditorExit,
    updateNote,
    setCenterView,
    setCursorPosition,
  })

  // ============================================================================
  // KEYBOARD SHORTCUTS
  // Handle all global keyboard shortcuts using the centralized hook.
  // IMPORTANT: Only ONE useKeyboardShortcuts call is allowed. Multiple calls
  // register duplicate event listeners, causing shortcuts to fire twice or
  // interfere with each other (e.g., Ctrl+M calling preventDefault but not
  // triggering the handler if onToggleMarkdownPreview is missing).
  // ============================================================================
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
            knowledgeLoading={knowledgeLoading}
            knowledgeError={knowledgeError}
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
            knowledgeBacklinks={backendBacklinks}
            knowledgeLoading={knowledgeLoading}
            knowledgeError={knowledgeError}
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
  const workspaceController = useWorkspaceController()
  const { workspaceRoot } = workspaceController

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
          <AppInner workspaceController={workspaceController} />
        </StudyProvider>
      </ThemeProvider>
    </>
  )
}
