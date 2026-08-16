# Knowledge Pipeline (Phase 2)

Hibiscus features a local-first, incremental knowledge indexing system designed to make your workspace deeply searchable without compromising performance or privacy.

The knowledge pipeline processes raw text, markdown, PDF, and DOCX files. It chunks them intelligently, extracts topics, and maintains a highly optimized inverted keyword index with advanced TF-IDF scoring entirely on your local machine.

## Design Constraints

The indexing system adheres strictly to the following architectural constraints:

- **Local-First**: All data processing and storage happens on-device.
- **Derived & Rebuildable**: The knowledge layer acts as a read-only cache. It is entirely derived from your workspace files and can be rebuilt at any time.
- **Immutable Source**: The pipeline will **never** mutate user files.
- **Memory Efficiency**: Chunks are streamed via buffered disk I/O, preventing bulk memory loading.
- **Non-Blocking**: All processing is relegated to an asynchronous background worker pool, maintaining a smooth UI thread.

## Pipeline Architecture

The pipeline processes files in a structured, step-by-step flow:

`Watcher -> Debounced Queue -> Worker Pool -> Parser -> Chunker -> Indexer -> Storage -> Query API`

### 1. Watcher

The filesystem watcher monitors your workspace root for any `Create`, `Modify`, or `Delete` events affecting `.md`, `.txt`, `.pdf`, and `.docx` files. These events are immediately forwarded to the knowledge queue.

**Initial Scan on Open**: When a workspace is first opened, `watch_workspace` now triggers `initial_scan()` automatically in a background thread before processing live events. This means the knowledge base, graph, and topic map are populated immediately on open — previously the index stayed empty until the user manually edited each file, because the pipeline was purely event-driven with no bootstrapping step.

During the scan, the watcher emits two Tauri events the frontend can listen for:

- `knowledge-indexing` (payload: `bool`) — `true` when the scan starts, `false` when it finishes.
- `knowledge-updated` — fired once after the scan completes to trigger a graph/search refetch.

`useBackendKnowledge` subscribes to both events and exposes an `indexing` state flag you can wire to a loading indicator.

### 2. Debounced Queue

To prevent redundant processing (e.g., rapid consecutive saves), events are debounced and deduplicated inside a queue. A batch is formed over a small time window and dispatched as a single unit to the worker pool.

### 3. Worker Pool

An asynchronous Tokio-based worker pool processes the batched events. Concurrency is bounded by the available CPU cores to prevent system starvation. Each file is processed entirely independently of others. 
**Ingestion Priorities**: Extremely large files (e.g., > 10MB) are efficiently bypassed to avoid unexpected memory spikes, ensuring background processing remains lightweight.

### 4. Parser System

A trait-based parser system (`Parser` trait in `knowledge/parser.rs`) extracts structured sections from the raw files. Each parser handles exactly one file format and returns `ParseError` on failure; the worker pool logs the error, marks the file as skipped, and moves on without halting the pipeline.

- **Markdown Parser**: Splits documents on ATX-style headings (`#`, `##`, etc.) using byte-level checks — no regex. Content before the first heading goes into a section with `heading: None`. Guarantees at least one section per file.
- **Text Parser**: Splits plain text on blank-line-separated paragraphs. Simple and allocation-efficient.
- **PDF Parser**: Calls `pdf_extract::extract_text_by_pages()` to extract text **per page**, using the page number (`"Page 1"`, `"Page 2"`, …) as each section's heading. This is intentional: a search hit in a 300-page document is useless without page provenance. Raw PDF text contains layout artifacts — hard line-breaks mid-sentence and hyphenated word-splits (`"knowl-\nedge"`) — so `normalize_pdf_text()` runs a single pass to rejoin them before chunking, otherwise those tokens never match full words in the index.
- **DOCX Parser**: Opens the file as a ZIP archive and streams `word/document.xml` through `quick-xml` in event mode, never loading the full DOM. `<w:p>` boundaries delimit paragraphs; `<w:pStyle>` attributes (`Heading1`, `Heading 2`, `Title`, `Subtitle`, and localized variants) mark section boundaries. Before this was implemented, every paragraph became a heading-less section and all Word content collapsed into the "General" topic — the document structure was completely invisible to the graph and topic grouping.

#### Adding a New Parser

Implement `Parser` (two methods: `supports(ext) -> bool` and `parse(path) -> Result<ParsedDocument, ParseError>`), then add it to the dispatch table at the bottom of `parser_for_path()`. The worker pool and chunker need no changes.

### 5. Chunker

The chunking engine splits the parsed sections into size-bounded chunks (typically 200-500 words). It guarantees:

- **Heading Preservation**: Every chunk retains the context of its parent heading.
- **Boundary Enforcement**: Chunks never cross file boundaries.
- **Deterministic Hashing**: Each chunk receives a deterministic, content-addressable ID to easily track changes.

### 6. Incremental Indexer & Topic Extraction

An inverted keyword index (`keyword -> [chunk_ids]`) is maintained. During processing, the indexer applies strict normalisation:

- Keywords are lowercased and stripped of alphanumeric padding.
- Common English stopwords are filtered out.
- Unchanged files are aggressively skipped using SHA-256 content hashes, ensuring only the delta is processed.

**TF-IDF Scored Index (Phase 2)**: 
After indexing, a lightweight TF-IDF score is precomputed for each keyword. This produces a `ScoredKeywordIndex` where `score = ln(1 + term_frequency) * ln(total_chunks / doc_frequency)`. This ensures that query-time ranking requires zero calculation.

**Topic Grouping**: 
In parallel, a lightweight heuristic topic grouping runs, clustering chunks into topics based on heading text overlap deterministically (without relying on ML or external clustering libraries). Heading normalisation is **case-insensitive and title-cased**: `"introduction"` and `"Introduction"` and `"INTRODUCTION"` all resolve to the same topic `"Introduction"`. This matters especially for PDF extraction, where the same heading may appear in different capitalisation across pages.

### 7. Storage Layer

Derived data is serialized to JSON and stored locally within `.hibiscus/knowledge/`.

- `manifest.json`: Tracks indexing metadata.
- `topics.json`: Maps topic names to chunk IDs.
- `index/keyword_index.json`: The core inverted keyword mapping (legacy Phase 1 compatibility).
- `index/scored_index.json`: The active TF-IDF scored inverted keyword mapping.
- `files/file_map.json`: Tracks the relationship between source files and derived chunk IDs.
- `chunks/<chunk_id>.json`: Individual chunk files, written atomically.

### 8. Query API & Caching Layer

The frontend interacts with the knowledge system via robust Tauri commands (`search_chunks`, `get_topics`, `get_chunk`). 

**Query Engine**:

- **Ranked Search**: Retrieves results using the precomputed TF-IDF scores.
- **Prefix Matching**: Keywords starting with a query term receive a slight relevance boost.
- **Fuzzy Matching**: Query terms within an edit distance of 1 receive a fuzzy boost, improving typo resilience.
- **Pagination**: Supports top-K limiting and offsets to handle large result sets elegantly.

**Caching**:
A custom in-memory LRU cache stores recent query results and retrieved chunks. This guarantees instant responses while typing. The cache implements an all-or-nothing invalidation strategy, seamlessly flushing stale results anytime a source file changes.


### Aggregate Rebuild Performance

A subtle O(n²) trap existed in the initial scan: `rebuild_note_metadata()`, `rebuild_scored_index()`, and `build_topic_map()` were each called after every individual file, so scanning 1000 files meant 3000 full-index rebuilds. These are now consolidated into a single `rebuild_aggregates(workspace_root, changed_file)` call that is **deferred** during batch scans and executed exactly once at the end. For live file-change events (post-scan) the function runs immediately, scoped to the changed file where possible, so incremental updates stay cheap.

## Robustness Upgrade Notes

The knowledge store now treats the backend index as the source of truth for both search and graph metadata. Chunk records include stable SHA-256-derived IDs, location metadata for line-aware navigation, tags, wiki-links, and aliases. Derived graph/backlink snapshots are persisted under `.hibiscus/knowledge/metadata/`.

Additional operational files are written alongside the index:

- `status.json`: current index health, schema version, counts, and progress basics.
- `errors.json`: recent indexing errors.
- `skipped_files.json`: files skipped due to size or exclusion rules.
- `.hibiscusignore`: optional workspace-level exclusion file with simple path-pattern matching.

Search remains local-first keyword retrieval for now. The query interface reserves `mode: "hybrid"` for future semantic/vector retrieval, but no remote or embedding dependency is used in this phase.
