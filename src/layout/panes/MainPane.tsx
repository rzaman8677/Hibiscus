import { KnowledgeGraphView } from "../../features/knowledge/KnowledgeGraphView"
import { TabBar } from "../../components/TabBar/TabBar"
import { EditorView, CursorPosition } from "../../components/Editor/EditorView"

export interface MainPaneProps {
  centerView: "editor" | "graph"
  setCenterView: (view: "editor" | "graph") => void
  knowledgeGraph: any
  activeFile: any | null
  activeFilePath: string | null
  activeFileId: string | null
  fileContent: string
  fileVersion: number
  openFiles: any[]
  markdownViewMode: "live-preview" | "source"
  onToggleMarkdownViewMode: () => void
  handleGraphNodeClick: (filePath: string) => void
  switchTab: (id: string) => void
  closeTab: (id: string) => void
  handleFileOpen: (node: { id: string; name: string; path: string; type: "file" | "folder" }) => void
  handleEditorChange: (value: string) => void
  setCursorPosition: (position: CursorPosition) => void
  saveCurrentFile: () => void
}

export function MainPane(props: MainPaneProps) {
  return (
    <>
      {/* Knowledge Graph — hidden when editor is active.
          Only mount after the user has toggled to graph at least once. */}
      {props.centerView === "graph" && (
        <KnowledgeGraphView
          graph={props.knowledgeGraph}
          activeFilePath={props.activeFilePath}
          onNodeClick={props.handleGraphNodeClick}
          onBack={() => props.setCenterView("editor")}
        />
      )}

      {/* Editor view — hidden (not unmounted) when graph is active.
          Using display:none preserves the Monaco editor instance,
          preventing content loss and blank editor bugs. */}
      <div
        className="editor-wrapper"
        style={{ display: props.centerView === "editor" ? undefined : "none" }}
      >
        {/* Tab bar -- visible only when at least one file is open */}
        <TabBar
          openFiles={props.openFiles}
          activeFileId={props.activeFileId}
          onSelectTab={props.switchTab}
          onCloseTab={props.closeTab}
          onDropFile={(node: { id: string; name: string; path: string; type: string }) => props.handleFileOpen({
            id: node.id,
            name: node.name,
            path: node.path,
            type: (node.type === "file" || node.type === "folder") ? node.type : "file",
          })}
        />

        {props.activeFile && props.activeFilePath ? (
          <>
            {/* Monaco editor container */}
            <div className="editor-container" style={{ position: 'relative' }}>
              {/* Markdown View Mode Toggle Button */}
              {props.activeFilePath.toLowerCase().endsWith('.md') && (
                <button
                  className="md-view-toggle-btn"
                  onClick={props.onToggleMarkdownViewMode}
                  title={`Switch to ${props.markdownViewMode === 'live-preview' ? 'Source' : 'Live Preview'} Mode (Ctrl+M)`}
                  style={{
                    position: 'absolute',
                    top: '8px',
                    right: '16px',
                    zIndex: 10,
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border)',
                    borderRadius: '4px',
                    padding: '4px 8px',
                    color: 'var(--text-secondary)',
                    fontSize: '12px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                  }}
                >
                  {props.markdownViewMode === 'live-preview' ? (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><line x1="10" y1="9" x2="8" y2="9"></line></svg>
                      <span>Source</span>
                    </>
                  ) : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                      <span>Preview</span>
                    </>
                  )}
                </button>
              )}
              <EditorView
                path={props.activeFilePath}
                content={props.fileContent}
                version={props.fileVersion}
                onChange={props.handleEditorChange}
                onCursorChange={props.setCursorPosition}
                onSave={props.saveCurrentFile}
                markdownViewMode={props.markdownViewMode}
              />
            </div>
          </>
        ) : (
          /* Placeholder when no file is selected */
          <div className="editor-placeholder">
            <span className="editor-placeholder-icon">
              <svg width="48" height="48" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M14 12.5C14 13.0523 13.5523 13.5 13 13.5H3C2.44772 13.5 2 13.0523 2 12.5V3.5C2 2.94772 2.44772 2.5 3 2.5H6L7.5 4.5H13C13.5523 4.5 14 4.94772 14 5.5V12.5Z" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </span>
            <span className="editor-placeholder-text">
              Select a file from the tree to start editing
            </span>
          </div>
        )}
      </div>
    </>
  )
}
