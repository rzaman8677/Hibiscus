import { useCallback, useState, type Dispatch, type SetStateAction } from "react"
import type { CursorPosition } from "../types/workspace"

export type CenterView = "editor" | "graph"

interface AppLayoutState {
  showLeftPanel: boolean
  showRightPanel: boolean
  showShortcutOverlay: boolean
  centerView: CenterView
  cursorPosition: CursorPosition
  setShowRightPanel: Dispatch<SetStateAction<boolean>>
  setShowShortcutOverlay: Dispatch<SetStateAction<boolean>>
  setCenterView: Dispatch<SetStateAction<CenterView>>
  setCursorPosition: Dispatch<SetStateAction<CursorPosition>>
  toggleLeftPanel: () => void
  toggleRightPanel: () => void
  toggleGraphView: () => void
}

export function useAppLayout(): AppLayoutState {
  const [showLeftPanel, setShowLeftPanel] = useState(true)
  const [showRightPanel, setShowRightPanel] = useState(false)
  const [showShortcutOverlay, setShowShortcutOverlay] = useState(false)
  const [centerView, setCenterView] = useState<CenterView>("editor")
  const [cursorPosition, setCursorPosition] = useState<CursorPosition>({
    line: 1,
    column: 1,
  })

  const toggleLeftPanel = useCallback(() => {
    setShowLeftPanel((visible) => !visible)
  }, [])

  const toggleRightPanel = useCallback(() => {
    setShowRightPanel((visible) => !visible)
  }, [])

  const toggleGraphView = useCallback(() => {
    setCenterView((view) => (view === "editor" ? "graph" : "editor"))
  }, [])

  return {
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
  }
}
