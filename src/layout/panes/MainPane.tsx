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
  showMarkdownPreview: boolean
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
            <div className="editor-container">
              <EditorView
                path={props.activeFilePath}
                content={props.fileContent}
                version={props.fileVersion}
                onChange={props.handleEditorChange}
                onCursorChange={props.setCursorPosition}
                onSave={props.saveCurrentFile}
                showMarkdownPreview={props.showMarkdownPreview}
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
