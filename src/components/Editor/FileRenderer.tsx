/**
 * ============================================================================  
 * FileRenderer Component
 * ============================================================================
 * 
 * Renders different file types inside the editor based on file extension.
 * Supports Markdown, PDF, DOCX, and PPTX with Monaco as fallback.
 * 
 * MARKDOWN RENDERING:
 * Markdown files are now rendered INLINE within Monaco via the
 * MarkdownInlineDecorator engine (Obsidian-style live preview).
 * The old split-pane ReactMarkdown preview has been removed.
 * Monaco occupies 100% width for .md files.
 * 
 * This component integrates with the existing data flow using:
 * - buffersRef for file content cache
 * - openFiles for file metadata
 * - fileLoader for unified binary/text reading
 * ============================================================================
 */

import { useState, useEffect } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import mammoth from 'mammoth'
import { loadBinaryFile } from '../../utils/fileLoader'

// Import react-pdf required styles
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'

// ---------------------------------------------------------------------------
// PDF.js Worker Setup — LOCAL, no CDN
// ---------------------------------------------------------------------------
// pdfjs-dist v5 uses .mjs files. Vite's ?url suffix gives us the local asset
// path at build time, avoiding CORS errors from unpkg/cdnjs.
// ---------------------------------------------------------------------------
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl

/**
 * File type detection from file path extension
 * Derives type ONLY from file path as required
 */
function getFileType(path: string): 'markdown' | 'pdf' | 'docx' | 'pptx' | 'monaco' {
  const ext = path.split('.').pop()?.toLowerCase()
  
  switch (ext) {
    case 'md':
      return 'markdown'
    case 'pdf':
      return 'pdf'
    case 'docx':
      return 'docx'
    case 'pptx':
      return 'pptx'
    default:
      return 'monaco'
  }
}

/**
 * Props for FileRenderer component
 * 
 * NOTE: showMarkdownPreview has been replaced by markdownViewMode.
 * Markdown files are always rendered inline via Monaco + MarkdownInlineDecorator.
 * The markdownViewMode ("live-preview" | "source") is handled upstream in
 * EditorView — this component no longer needs to manage the preview pane.
 */
interface FileRendererProps {
  file: { path: string }
  content: string
  children: React.ReactNode
  markdownViewMode?: "live-preview" | "source"
}

/**
 * PDF Viewer Component
 * Uses react-pdf with local worker and Tauri binary reading.
 * Worker is loaded from node_modules (no CDN/CORS issues).
 */
function PdfViewer({ file }: { file: { path: string } }) {
  const [pdfData, setPdfData] = useState<{ data: Uint8Array } | null>(null)
  const [error, setError] = useState<string>('')

  useEffect(() => {
    let cancelled = false

    const loadPdf = async () => {
      try {
        // Read binary via unified loader
        const arrayBuffer = await loadBinaryFile(file.path)

        if (cancelled) return

        // Pass raw bytes to react-pdf (avoids Blob URL lifecycle issues)
        setPdfData({ data: new Uint8Array(arrayBuffer) })
      } catch (err) {
        if (!cancelled) {
          setError('Failed to load PDF file')
          console.error('[Hibiscus] PDF loading error:', err)
        }
      }
    }

    // Reset state for new file
    setPdfData(null)
    setError('')
    loadPdf()

    return () => { cancelled = true }
  }, [file.path])

  if (error) {
    return (
      <div style={{ 
        padding: '20px', 
        height: '100%', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        color: 'var(--text-secondary)'
      }}>
        {error}
      </div>
    )
  }

  if (!pdfData) {
    return (
      <div style={{ 
        padding: '20px', 
        height: '100%', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        color: 'var(--text-secondary)'
      }}>
        Loading PDF…
      </div>
    )
  }

  return (
    <div style={{ 
      height: '100%', 
      overflow: 'auto',
      display: 'flex',
      justifyContent: 'center',
      backgroundColor: 'var(--bg-primary)'
    }}>
      <Document
        file={pdfData}
        loading={<div style={{ padding: '20px' }}>Loading PDF…</div>}
        error={<div style={{ padding: '20px', color: 'var(--error)' }}>Failed to load PDF</div>}
      >
        <Page 
          pageNumber={1} 
          renderTextLayer={true}
          renderAnnotationLayer={false}
          width={Math.max(600, window.innerWidth * 0.6)}
        />
      </Document>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DOCX HTML Cache — persists across re-renders to avoid re-conversion
// ---------------------------------------------------------------------------
const docxCache = new Map<string, string>()

/**
 * DOCX Viewer Component
 * Uses mammoth to convert DOCX to HTML.
 *
 * CRITICAL FIX: Tauri's read_file_binary returns Vec<u8> serialized as
 * JSON number[]. We use loadBinaryFile() which converts to ArrayBuffer
 * via new Uint8Array(bytes).buffer before passing to mammoth.
 */
function DocxViewer({ file }: { file: { path: string } }) {
  const [htmlContent, setHtmlContent] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(true)

  useEffect(() => {
    let cancelled = false

    const convertDocx = async () => {
      try {
        setLoading(true)
        setError('')

        // Check cache first — avoid re-converting on tab switch
        const cached = docxCache.get(file.path)
        if (cached !== undefined) {
          setHtmlContent(cached)
          setLoading(false)
          return
        }

        // Read binary via unified loader (returns real ArrayBuffer)
        const arrayBuffer = await loadBinaryFile(file.path)
        if (cancelled) return

        // mammoth expects { arrayBuffer: ArrayBuffer }
        const result = await mammoth.convertToHtml({ arrayBuffer })
        if (cancelled) return

        // Cache and display
        docxCache.set(file.path, result.value)
        setHtmlContent(result.value)
        
        if (result.messages.length > 0) {
          console.warn('[Hibiscus] DOCX conversion warnings:', result.messages)
        }
      } catch (err) {
        if (!cancelled) {
          setError('Failed to load DOCX file. The file may be corrupted.')
          console.error('[Hibiscus] DOCX loading error:', err)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    convertDocx()
    return () => { cancelled = true }
  }, [file.path])

  if (loading) {
    return (
      <div style={{ 
        padding: '20px', 
        height: '100%', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        color: 'var(--text-secondary)'
      }}>
        Loading DOCX…
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ 
        padding: '20px', 
        height: '100%', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        color: 'var(--text-secondary)'
      }}>
        {error}
      </div>
    )
  }

  return (
    <div 
      style={{ 
        padding: '20px', 
        height: '100%', 
        overflow: 'auto',
        backgroundColor: 'var(--bg-primary)',
        color: 'var(--text-primary)'
      }}
      dangerouslySetInnerHTML={{ __html: htmlContent }}
    />
  )
}

/**
 * PPTX Viewer Component
 * Minimal fallback preview as specified
 */
function PptxViewer() {
  return (
    <div style={{ 
      padding: '20px', 
      height: '100%', 
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'center',
      color: 'var(--text-secondary)'
    }}>
      Preview not supported yet
    </div>
  )
}

/**
 * Main FileRenderer Component
 * 
 * KEY CHANGE: Markdown files no longer have a split-pane layout.
 * The ReactMarkdown preview pane has been removed entirely.
 * Monaco now occupies 100% of the editor width for .md files,
 * with inline live preview handled by MarkdownInlineDecorator
 * (managed in EditorView.tsx).
 */
export function FileRenderer({ file, content: _content, children, markdownViewMode: _markdownViewMode = "live-preview" }: FileRendererProps) {
  const fileType = getFileType(file.path)
  
  // Is this an editable text file? (Not a binary/document format)
  const isEditable = !['pdf', 'docx', 'pptx'].includes(fileType)

  return (
    <>
      {/* 
        CRITICAL: ALWAYS render the editor children in the exact same DOM tree position.
        Switching between file types (e.g. Markdown -> TS -> PDF) must NEVER unmount
        the `{children}` wrapper, otherwise the Monaco instance is destroyed permanently.
        For non-editable files, we simply hide this wrapper with display: none.

        CHANGE: Markdown files now always get full width — no split pane.
        The old divider + ReactMarkdown preview has been removed.
        Inline live preview is handled by MarkdownInlineDecorator in the Monaco layer.
      */}
      <div style={{ 
        display: isEditable ? 'flex' : 'none', 
        height: '100%', 
        minHeight: 0, 
        overflow: 'hidden',
        flex: 1
      }}>
        {/* Editor pane — always full width now (split pane removed) */}
        <div style={{
          width: '100%',
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column' as const,
        }}>
          {children} {/* Monaco Editor Container */}
        </div>
      </div>

      {/* Render non-editable viewers alongside the hidden editor */}
      {fileType === 'pdf' && <PdfViewer file={file} />}
      {fileType === 'docx' && <DocxViewer file={file} />}
      {fileType === 'pptx' && <PptxViewer />}
    </>
  )
}
