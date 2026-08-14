import { useState, useCallback, useEffect } from "react"
import { invoke } from "@tauri-apps/api/core"
import { SearchInput } from "./SearchInput"
import { ResultsList } from "./ResultsList"
import { TopicsDropdown } from "./TopicsDropdown"
import "./search.css"

interface SearchResult {
  chunk_id: string
  file: string
  heading?: string
  content: string
  word_count: number
  score: number
  start_line?: number
  end_line?: number
  matched_terms?: string[]
  tags?: string[]
  topic?: string
}

interface KnowledgeStatus {
  state: string
  indexed_files: number
  chunk_count: number
  schema_version: number
  last_indexed: string
  last_rebuild: string
  error_count: number
  skipped_count: number
  needs_rebuild: boolean
}

interface TopicMap {
  [topic: string]: string[]
}

interface IndexingError {
  file?: string
  message: string
  timestamp: string
}

interface SkippedFile {
  file: string
  reason: string
  timestamp: string
}

interface SearchPanelProps {
  open: boolean
  onClose: () => void
  workspaceRoot: string | null
  onOpenFile?: (path: string, line?: number) => void
}

export function SearchPanel({ open, onClose, workspaceRoot, onOpenFile }: SearchPanelProps) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchResult[]>([])
  const [topics, setTopics] = useState<TopicMap>({})
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [resultCount, setResultCount] = useState(0)
  const [hasSearched, setHasSearched] = useState(false)
  const [status, setStatus] = useState<KnowledgeStatus | null>(null)
  const [showDashboard, setShowDashboard] = useState(false)
  const [indexingErrors, setIndexingErrors] = useState<IndexingError[]>([])
  const [skippedFiles, setSkippedFiles] = useState<SkippedFile[]>([])

  // Debounced search
  const debouncedSearch = useCallback(
    async (searchQuery: string) => {
      if (!workspaceRoot || !searchQuery.trim()) {
        setResults([])
        setResultCount(0)
        return
      }

      setHasSearched(true)
      setLoading(true)
      try {
        const searchResults = await invoke<SearchResult[]>("search_chunks", {
          query: searchQuery,
          offset: 0,
          limit: 20,
          topic: selectedTopic,
          tags: [],
          fileTypes: [],
          folder: null,
          heading: null,
          mode: "keyword"
        })
        setResults(searchResults)
        setResultCount(searchResults.length)
      } catch (error) {
        console.error("Search failed:", error)
        setResults([])
        setResultCount(0)
      } finally {
        setLoading(false)
      }
    },
    [workspaceRoot, selectedTopic]
  )

  const loadStatus = useCallback(async () => {
    if (!workspaceRoot) return
    try {
      const [statusData, errors, skipped] = await Promise.all([
        invoke<KnowledgeStatus>("get_knowledge_status"),
        invoke<IndexingError[]>("get_indexing_errors"),
        invoke<SkippedFile[]>("get_skipped_files"),
      ])
      setStatus(statusData)
      setIndexingErrors(errors ?? [])
      setSkippedFiles(skipped ?? [])
    } catch (error) {
      console.error("Failed to load knowledge status:", error)
    }
  }, [workspaceRoot])

  // Load topics
  const loadTopics = useCallback(async () => {
    if (!workspaceRoot) return
    try {
      const topicData = await invoke<TopicMap>("get_topics")
      setTopics(topicData)
    } catch (error) {
      console.error("Failed to load topics:", error)
    }
  }, [workspaceRoot])


  const rebuildIndex = useCallback(async () => {
    await invoke("rebuild_knowledge_index")
    await loadStatus()
    await loadTopics()
    if (query.trim()) debouncedSearch(query)
  }, [debouncedSearch, loadStatus, loadTopics, query])

  const clearIndex = useCallback(async () => {
    await invoke("clear_knowledge_index")
    setResults([])
    await loadStatus()
    await loadTopics()
  }, [loadStatus, loadTopics])

  // Initialize topics on mount and reset search state
  useEffect(() => {
    if (open) {
      loadTopics()
      loadStatus()
      setHasSearched(false)
    }
  }, [open, loadTopics, loadStatus])

  // Handle search with debounce
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      debouncedSearch(query)
    }, 250)

    return () => clearTimeout(timeoutId)
  }, [query, debouncedSearch])

  const handleTopicSelect = useCallback((topic: string | null) => {
    setSelectedTopic(topic)
    if (query.trim()) debouncedSearch(query)
  }, [query, debouncedSearch])

  if (!open) return null

  return (
    <div className="search-panel">
      <div className="search-header">
        <div className="search-header-left">
          <span>Search Knowledge Base</span>
          {status && <button className={`knowledge-status-badge state-${status.state.toLowerCase().replace(/\s+/g, "-")}`} onClick={() => setShowDashboard((v) => !v)}>{status.state}{status.error_count > 0 ? ` / ${status.error_count} error${status.error_count === 1 ? "" : "s"}` : ""}{status.skipped_count > 0 ? ` / ${status.skipped_count} skipped` : ""}</button>}
          {loading && <span className="search-loading">(Loading...)</span>}
        </div>
        <button className="search-close" onClick={onClose}>
          ×
        </button>
      </div>

      {showDashboard && status && (
        <div className="knowledge-dashboard">
          <div><strong>{status.indexed_files}</strong> files / <strong>{status.chunk_count}</strong> chunks</div>
          <div>Schema v{status.schema_version} / Errors {status.error_count} / Skipped {status.skipped_count}</div>

          {indexingErrors.length > 0 && (
            <div className="knowledge-issues knowledge-issues-error">
              <div className="knowledge-issues-title">Failed to index ({indexingErrors.length})</div>
              <ul className="knowledge-issues-list">
                {indexingErrors.slice(-8).reverse().map((err, i) => (
                  <li key={i} title={err.message}>
                    <span className="knowledge-issue-file">{err.file ? err.file.split(/[\\/]/).pop() : "(unknown)"}</span>
                    <span className="knowledge-issue-reason">{err.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {skippedFiles.length > 0 && (
            <div className="knowledge-issues knowledge-issues-skipped">
              <div className="knowledge-issues-title">Skipped ({skippedFiles.length})</div>
              <ul className="knowledge-issues-list">
                {skippedFiles.slice(-8).reverse().map((sf, i) => (
                  <li key={i} title={sf.file}>
                    <span className="knowledge-issue-file">{sf.file.split(/[\\/]/).pop()}</span>
                    <span className="knowledge-issue-reason">{sf.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="knowledge-dashboard-actions">
            <button onClick={rebuildIndex}>Rebuild</button>
            <button onClick={clearIndex}>Clear</button>
          </div>
        </div>
      )}

      <div className="search-input-row">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search your knowledge base..."
        />
        <TopicsDropdown
          topics={topics}
          selectedTopic={selectedTopic}
          onTopicSelect={handleTopicSelect}
        />
      </div>

      <div className="search-body">
        <ResultsList results={results} hasSearched={hasSearched} onOpenFile={onOpenFile} />
      </div>

      <div className="search-footer">
        {hasSearched && resultCount > 0 && (
          <span>{Math.min(resultCount, 20)} of {resultCount} results</span>
        )}
      </div>
    </div>
  )
}
