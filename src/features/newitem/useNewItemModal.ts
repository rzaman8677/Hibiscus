import { useCallback, useState } from "react"
import type { NewItemMode } from "./types"

interface NewItemModalState {
  open: boolean
  mode: NewItemMode
}

interface NewItemModalController {
  modal: NewItemModalState
  openFileModal: () => void
  openFolderModal: () => void
  closeModal: () => void
}

const CLOSED_MODAL: NewItemModalState = { open: false, mode: "file" }

export function useNewItemModal(workspaceRoot: string | null): NewItemModalController {
  const [modal, setModal] = useState<NewItemModalState>(CLOSED_MODAL)

  const openModal = useCallback((mode: NewItemMode) => {
    if (!workspaceRoot) {
      console.warn("Please open a workspace first")
      return
    }

    setModal({ open: true, mode })
  }, [workspaceRoot])

  const openFileModal = useCallback(() => openModal("file"), [openModal])
  const openFolderModal = useCallback(() => openModal("folder"), [openModal])
  const closeModal = useCallback(() => setModal(CLOSED_MODAL), [])

  return { modal, openFileModal, openFolderModal, closeModal }
}
