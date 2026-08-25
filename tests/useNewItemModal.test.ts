import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useNewItemModal } from "../src/features/newitem/useNewItemModal"

describe("useNewItemModal", () => {
  it("opens in the requested mode and resets to file mode when closed", () => {
    const { result } = renderHook(() => useNewItemModal("/workspace"))

    act(() => result.current.openFolderModal())
    expect(result.current.modal).toEqual({ open: true, mode: "folder" })

    act(() => result.current.closeModal())
    expect(result.current.modal).toEqual({ open: false, mode: "file" })

    act(() => result.current.openFileModal())
    expect(result.current.modal).toEqual({ open: true, mode: "file" })
  })

  it("does not open without a workspace", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const { result } = renderHook(() => useNewItemModal(null))

    act(() => result.current.openFileModal())

    expect(result.current.modal).toEqual({ open: false, mode: "file" })
    expect(warn).toHaveBeenCalledWith("Please open a workspace first")
    warn.mockRestore()
  })
})
