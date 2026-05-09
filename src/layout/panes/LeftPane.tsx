import { TreeView } from "../../components/Tree/TreeView"

type LeftPaneProps = {
  visible: boolean
  hiddenByFocusMode: boolean
  tree: any
  activeNodeId?: string
  onOpen: (...args: any[]) => void
  onNewFile: () => void
  onNewFolder: () => void
  onMoveNode: (...args: any[]) => void
  onToggleGraph: () => void
}

export function LeftPane({
  visible,
  hiddenByFocusMode,
  tree,
  activeNodeId,
  onOpen,
  onNewFile,
  onNewFolder,
  onMoveNode,
  onToggleGraph,
}: LeftPaneProps) {
  if (!visible || hiddenByFocusMode) {
    return null
  }

  return (
    <TreeView
      tree={tree}
      activeNodeId={activeNodeId}
      onOpen={onOpen}
      onNewFile={onNewFile}
      onNewFolder={onNewFolder}
      onMoveNode={onMoveNode}
      onToggleGraph={onToggleGraph}
    />
  )
}