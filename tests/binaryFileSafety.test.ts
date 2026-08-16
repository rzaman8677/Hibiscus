/**
 * ============================================================================
 * Binary File Safety Tests
 * ============================================================================
 *
 * Regression tests for the data-loss bugs where binary documents (PDF, DOCX)
 * could be destroyed by the text-editor save path.
 *
 * Binary files are opened read-only with an EMPTY placeholder buffer so Monaco
 * has something to bind to. Before these guards existed, that empty string
 * could reach `write_text_file` and truncate the real document to zero bytes:
 *
 *  1. Monaco stays mounted (hidden) while a PDF is active, so it could emit a
 *     change event -> buffer marked dirty -> 1s debounced auto-save -> file gone.
 *  2. "Save As" wrote `buffer.content` (empty) instead of copying the bytes.
 *  3. The unmount handler wrote every dirty buffer as text.
 *
 * These tests assert the guards hold, because the failure mode is silent and
 * unrecoverable.
 * ============================================================================
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const mockInvoke = vi.fn()
let capturedFsChangedHandler: ((event: { payload: string[] }) => void) | null = null

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
    listen: (eventName: string, handler: (event: { payload: string[] }) => void) => {
        if (eventName === 'fs-changed') capturedFsChangedHandler = handler
        return Promise.resolve(() => {
            capturedFsChangedHandler = null
        })
    },
}))

vi.mock('@tauri-apps/api/path', () => ({
    isAbsolute: () => Promise.resolve(true),
    join: (...parts: string[]) => Promise.resolve(parts.join('\\')),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
    save: vi.fn(() => Promise.resolve('C:\\ws\\copy.pdf')),
}))

import { useEditorController } from '../src/hooks/useEditorController'
import { isBinaryFile } from '../src/utils/fileLoader'

const WORKSPACE = 'C:\\ws'
const PDF_PATH = 'C:\\ws\\paper.pdf'
const DOCX_PATH = 'C:\\ws\\report.docx'
const MD_PATH = 'C:\\ws\\notes.md'

/**
 * Text writes issued to a specific path.
 *
 * Filtered by path deliberately: the controller also persists its session via
 * `write_text_file`, so asserting "no write_text_file at all" would fail for
 * reasons unrelated to document safety. The invariant that matters is that
 * nothing writes text to the *document* itself.
 */
const textWritesTo = (path: string) =>
    mockInvoke.mock.calls.filter(
        ([cmd, args]) => cmd === 'write_text_file' && (args as any)?.path === path
    )

beforeEach(() => {
    vi.clearAllMocks()
    capturedFsChangedHandler = null
    mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'read_text_file') return Promise.resolve('# hello')
        if (cmd === 'file_exists') return Promise.resolve(true)
        if (cmd === 'read_file_binary') return Promise.resolve([1, 2, 3])
        return Promise.resolve(undefined)
    })
})

describe('isBinaryFile classification', () => {
    it('treats document formats as binary', () => {
        expect(isBinaryFile(PDF_PATH)).toBe(true)
        expect(isBinaryFile(DOCX_PATH)).toBe(true)
        expect(isBinaryFile('a.PDF')).toBe(true)
    })

    it('treats text formats as editable', () => {
        expect(isBinaryFile(MD_PATH)).toBe(false)
        expect(isBinaryFile('main.ts')).toBe(false)
    })
})

describe('binary documents are never written as text', () => {
    it('does not read a PDF as text when opening it', async () => {
        const { result } = renderHook(() => useEditorController(WORKSPACE))

        await act(async () => {
            await result.current.openFile({
                id: PDF_PATH, name: 'paper.pdf', path: PDF_PATH, type: 'file',
            })
        })

        const textReads = mockInvoke.mock.calls.filter(
            ([cmd, args]) => cmd === 'read_text_file' && (args as any)?.path === PDF_PATH
        )
        expect(textReads).toHaveLength(0)
    })

    it('ignores editor change events for a PDF (no dirty state, no auto-save)', async () => {
        vi.useFakeTimers()
        try {
            const { result } = renderHook(() => useEditorController(WORKSPACE))

            await act(async () => {
                await result.current.openFile({
                    id: PDF_PATH, name: 'paper.pdf', path: PDF_PATH, type: 'file',
                })
            })

            // Simulate Monaco emitting a change while the (hidden) editor is
            // bound to the PDF's placeholder buffer.
            act(() => {
                result.current.onChange('accidental keystroke')
            })

            // Advance past the 1s auto-save debounce.
            await act(async () => {
                vi.advanceTimersByTime(5000)
            })

            expect(result.current.isDirty).toBe(false)
            expect(textWritesTo(PDF_PATH)).toHaveLength(0)
        } finally {
            vi.useRealTimers()
        }
    })

    it('saveCurrentFile does not write a PDF', async () => {
        const { result } = renderHook(() => useEditorController(WORKSPACE))

        await act(async () => {
            await result.current.openFile({
                id: PDF_PATH, name: 'paper.pdf', path: PDF_PATH, type: 'file',
            })
        })

        await act(async () => {
            await result.current.saveCurrentFile()
        })

        expect(textWritesTo(PDF_PATH)).toHaveLength(0)
    })

    it('Save As copies bytes instead of writing an empty text file', async () => {
        const { result } = renderHook(() => useEditorController(WORKSPACE))

        await act(async () => {
            await result.current.openFile({
                id: PDF_PATH, name: 'paper.pdf', path: PDF_PATH, type: 'file',
            })
        })

        await act(async () => {
            await result.current.saveAsFile()
        })

        expect(textWritesTo(PDF_PATH)).toHaveLength(0)
        const copies = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'copy_file')
        expect(copies).toHaveLength(1)
        expect(copies[0][1]).toMatchObject({ source: PDF_PATH })
    })

    it('still saves ordinary text files normally', async () => {
        const { result } = renderHook(() => useEditorController(WORKSPACE))

        await act(async () => {
            await result.current.openFile({
                id: MD_PATH, name: 'notes.md', path: MD_PATH, type: 'file',
            })
        })

        act(() => {
            result.current.onChange('# edited')
        })

        await act(async () => {
            await result.current.saveCurrentFile()
        })

        const writes = textWritesTo(MD_PATH)
        expect(writes.length).toBeGreaterThan(0)
        expect(writes[writes.length - 1][1]).toMatchObject({
            path: MD_PATH,
            contents: '# edited',
        })
    })
})

describe('external change handling for binary documents', () => {
    it('does not close a DOCX tab when the file changes on disk', async () => {
        const { result } = renderHook(() => useEditorController(WORKSPACE))

        await act(async () => {
            await result.current.openFile({
                id: DOCX_PATH, name: 'report.docx', path: DOCX_PATH, type: 'file',
            })
        })

        await waitFor(() => expect(capturedFsChangedHandler).not.toBeNull())

        // Reading a DOCX as text throws; the handler used to treat that as
        // "file deleted" and drop the tab.
        mockInvoke.mockImplementation((cmd: string) => {
            if (cmd === 'read_text_file') return Promise.reject(new Error('invalid utf-8'))
            return Promise.resolve(undefined)
        })

        await act(async () => {
            capturedFsChangedHandler?.({ payload: [DOCX_PATH] })
        })

        expect(result.current.openFiles.some((f) => f.path === DOCX_PATH)).toBe(true)
        expect(result.current.activeFilePath).toBe(DOCX_PATH)
    })
})
