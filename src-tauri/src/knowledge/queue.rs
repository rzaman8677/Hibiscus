//! ============================================================================
//! Debounced Async Queue and Worker Pool
//! ============================================================================
//!
//! Bridges the watcher (which runs in a synchronous OS thread) and the async
//! processing pipeline. The architecture is:
//!
//!   Watcher thread --[mpsc::channel]--> Queue task --[batching]--> Worker pool
//!
//! DESIGN DECISIONS:
//! - The queue is a Tokio task, not a thread, so it cooperates with the
//!   async runtime used by the rest of the pipeline.
//! - Events are debounced and deduplicated before being dispatched to workers.
//!   This means rapid saves on the same file produce a single processing run.
//! - Concurrency is bounded by `num_cpus` (or a fallback of 4) to prevent
//!   CPU contention on machines with many cores.
//! - Each file is processed independently: parse -> chunk -> index -> store.
//!   A failure in one file does not affect others.
//!
//! IMPORTANT: The `KnowledgeState` struct is registered as Tauri managed state
//! in `lib.rs`. It holds the sender half of the channel so that `watcher.rs`
//! can enqueue events, and the workspace root so the pipeline knows where to
//! read/write knowledge data.
//! ============================================================================

use crate::knowledge::cache::KnowledgeCache;
use crate::knowledge::chunker;
use crate::knowledge::indexer;
use crate::knowledge::parser;
use crate::knowledge::storage;
use crate::knowledge::topics;
use crate::knowledge::types::{
    BacklinkMap, FileEvent, FileEventType, KnowledgeError, KnowledgeGraph, KnowledgeGraphEdge,
    KnowledgeGraphNode, KnowledgeStatus, NoteIndex, NoteMetadata, SkippedFile,
    LARGE_FILE_THRESHOLD, current_schema_version,
};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, Semaphore};

/// Debounce window for batching filesystem events before processing.
const DEBOUNCE_MS: u64 = 750;

/// Maximum number of events to batch before forcing a flush, even if the
/// debounce window has not elapsed. Prevents unbounded accumulation during
/// large bulk operations (e.g., git checkout).
const MAX_BATCH_SIZE: usize = 64;

// ---------------------------------------------------------------------------
// KnowledgeState: Tauri managed state
// ---------------------------------------------------------------------------

/// Shared state for the knowledge indexing system.
///
/// Registered with `app.manage(KnowledgeState::new(...))` in `lib.rs`.
/// The watcher thread uses the `sender` to enqueue events; the background
/// consumer task picks them up and processes them.
pub struct KnowledgeState {
    /// Sender half of the event channel. Cloned into the watcher thread.
    pub sender: mpsc::UnboundedSender<FileEvent>,
    /// Receiver half, wrapped in a Mutex because Tokio's receiver is !Sync.
    /// The background task takes ownership of the inner value on startup.
    receiver: Mutex<Option<mpsc::UnboundedReceiver<FileEvent>>>,
    /// Workspace root path. Set when `watch_workspace` is called.
    pub workspace_root: Mutex<Option<String>>,
    /// In-memory LRU cache for query results and chunk retrieval (Phase 2).
    /// Wrapped in Mutex for async-safe access from Tauri command handlers.
    pub cache: Mutex<KnowledgeCache>,
    pub status: Mutex<KnowledgeStatus>,
    pub errors: Mutex<Vec<KnowledgeError>>,
    pub skipped_files: Mutex<Vec<SkippedFile>>,
    pub write_lock: Mutex<()>,
}

impl KnowledgeState {
    /// Create a new KnowledgeState with a fresh channel.
    pub fn new() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            sender: tx,
            receiver: Mutex::new(Some(rx)),
            workspace_root: Mutex::new(None),
            cache: Mutex::new(KnowledgeCache::new()),
            status: Mutex::new(KnowledgeStatus::default()),
            errors: Mutex::new(Vec::new()),
            skipped_files: Mutex::new(Vec::new()),
            write_lock: Mutex::new(()),
        }
    }

    /// Take the receiver out of the state. This can only succeed once;
    /// subsequent calls return `None`. The background consumer task calls
    /// this at startup.
    pub async fn take_receiver(&self) -> Option<mpsc::UnboundedReceiver<FileEvent>> {
        self.receiver.lock().await.take()
    }

    /// Update the workspace root. Called when the user opens a new workspace.
    pub async fn set_workspace_root(&self, root: String) {
        *self.workspace_root.lock().await = Some(root);
    }

    /// Get the current workspace root, if set.
    pub async fn get_workspace_root(&self) -> Option<String> {
        self.workspace_root.lock().await.clone()
    }

    pub async fn set_status_state(&self, state: &str) {
        self.status.lock().await.state = state.to_string();
    }

    pub async fn record_error(&self, file: Option<String>, message: String) {
        let mut errors = self.errors.lock().await;
        errors.push(KnowledgeError { file, message, timestamp: chrono_now_iso() });
        if errors.len() > 100 {
            errors.remove(0);
        }
        self.status.lock().await.error_count = errors.len();
    }

    pub async fn record_skip(&self, file: String, reason: String) {
        let mut skipped = self.skipped_files.lock().await;
        skipped.push(SkippedFile { file, reason, timestamp: chrono_now_iso() });
        if skipped.len() > 200 {
            skipped.remove(0);
        }
        self.status.lock().await.skipped_count = skipped.len();
    }
}

impl Default for KnowledgeState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Background consumer task
// ---------------------------------------------------------------------------

/// Spawn the background consumer task that drains the event channel,
/// batches events, and dispatches them to the worker pool.
///
/// This should be called once during app startup (in `lib.rs` setup hook).
/// The task runs for the lifetime of the application.
pub fn spawn_knowledge_worker(state: Arc<KnowledgeState>) {
    tauri::async_runtime::spawn(async move {
        // Take ownership of the receiver. If it has already been taken
        // (e.g., double init), exit silently.
        let mut receiver = match state.take_receiver().await {
            Some(rx) => rx,
            None => {
                eprintln!("[Knowledge] Worker: receiver already taken, exiting.");
                return;
            }
        };

        println!("[Knowledge] Background worker started.");

        // Determine concurrency limit: number of logical CPUs, minimum 2.
        let max_concurrency = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .max(2);
        let semaphore = Arc::new(Semaphore::new(max_concurrency));

        loop {
            // Wait for the first event (blocking the task, not a thread).
            let first = match receiver.recv().await {
                Some(ev) => ev,
                None => {
                    println!("[Knowledge] Event channel closed, worker shutting down.");
                    break;
                }
            };

            // Accumulate a batch: collect all events that arrive within the
            // debounce window, up to MAX_BATCH_SIZE.
            let mut batch: HashMap<String, FileEventType> = HashMap::new();
            batch.insert(first.path.clone(), first.event_type.clone());

            let deadline = tokio::time::Instant::now()
                + tokio::time::Duration::from_millis(DEBOUNCE_MS);

            loop {
                if batch.len() >= MAX_BATCH_SIZE {
                    break;
                }
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match tokio::time::timeout(remaining, receiver.recv()).await {
                    Ok(Some(ev)) => {
                        // Later events for the same path overwrite earlier ones.
                        // This handles rapid Create -> Modify sequences naturally.
                        batch.insert(ev.path.clone(), ev.event_type);
                    }
                    Ok(None) => {
                        // Channel closed while batching.
                        break;
                    }
                    Err(_) => {
                        // Timeout: debounce window elapsed.
                        break;
                    }
                }
            }

            // Deduplicate: the HashMap already ensures one entry per path.
            // Now dispatch each file to the worker pool.
            let workspace_root = match state.get_workspace_root().await {
                Some(root) => root,
                None => {
                    eprintln!("[Knowledge] No workspace root set, skipping batch.");
                    continue;
                }
            };

            // Ensure storage directories exist before processing.
            if let Err(e) = storage::ensure_dirs(&workspace_root) {
                eprintln!("[Knowledge] Failed to create storage dirs: {}", e);
                continue;
            }

            for (path, event_type) in batch {
                let ws = workspace_root.clone();
                let sem = semaphore.clone();
                let state_for_task = state.clone();
                let path_for_status = path.clone();

                tauri::async_runtime::spawn(async move {
                    // Acquire a permit to bound concurrency.
                    let _permit = match sem.acquire().await {
                        Ok(p) => p,
                        Err(_) => return,
                    };

                    // Use spawn_blocking for the CPU-bound + synchronous I/O work.
                    // This prevents blocking the Tokio runtime's async threads.
                    state_for_task.set_status_state("Indexing").await;
                    {
                        let mut status = state_for_task.status.lock().await;
                        status.active_count += 1;
                    }
                    let _write_guard = state_for_task.write_lock.lock().await;

                    let result = tokio::task::spawn_blocking(move || {
                        process_file_event(&ws, &path, &event_type)
                    })
                    .await;

                    match result {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => {
                            eprintln!("[Knowledge] Processing error: {}", e);
                            state_for_task.record_error(Some(path_for_status.clone()), e).await;
                        }
                        Err(e) => {
                            eprintln!("[Knowledge] Task panic: {}", e);
                            state_for_task.record_error(Some(path_for_status.clone()), format!("Task panic: {}", e)).await;
                        }
                    }
                    let workspace = state_for_task.get_workspace_root().await;
                    if let Some(workspace) = workspace {
                        let manifest = storage::read_manifest(&workspace);
                        let errors = state_for_task.errors.lock().await.clone();
                        let skipped = state_for_task.skipped_files.lock().await.clone();
                        let mut status = state_for_task.status.lock().await;
                        status.state = if errors.is_empty() { "Ready" } else { "Errors" }.to_string();
                        status.indexed_files = manifest.file_count;
                        status.chunk_count = manifest.chunk_count;
                        status.schema_version = manifest.schema_version;
                        status.last_indexed = manifest.last_indexed;
                        status.last_rebuild = manifest.last_rebuild;
                        status.last_processed_file = Some(path_for_status);
                        status.error_count = errors.len();
                        status.skipped_count = skipped.len();
                        status.active_count = status.active_count.saturating_sub(1);
                        let _ = storage::write_status(&workspace, &status);
                        let _ = storage::write_errors(&workspace, &errors);
                        let _ = storage::write_skipped_files(&workspace, &skipped);
                    }
                });
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Per-file processing (runs inside spawn_blocking)
// ---------------------------------------------------------------------------

/// Process a single file event: parse, chunk, index, store.
///
/// This function is designed to be called from `spawn_blocking` because it
/// performs synchronous disk I/O. All operations are scoped to a single file,
/// so failures here do not affect other files in the batch.
///
/// The incremental processing flow:
/// 1. For Delete events: remove old chunks and index entries.
/// 2. For Create/Modify: hash the file and compare to the stored hash.
///    - If unchanged: skip entirely (no work).
///    - If changed: remove old data, re-parse, re-chunk, re-index.
fn process_file_event(
    workspace_root: &str,
    file_path: &str,
    event_type: &FileEventType,
) -> Result<(), String> {
    match event_type {
        FileEventType::Delete => {
            remove_file_data(workspace_root, file_path)?;
            println!("[Knowledge] Removed index data for deleted file: {}", file_path);
        }
        FileEventType::Create | FileEventType::Modify | FileEventType::Rename => {
            // Filter: only process supported file types.
            if !is_indexable_file(file_path) || should_ignore_for_knowledge(workspace_root, file_path) {
                return Ok(());
            }

            // Phase 2: check file size threshold. Large files are deferred
            // to prevent memory spikes during parsing.
            let fsize = storage::file_size(file_path);
            if fsize > LARGE_FILE_THRESHOLD {
                eprintln!(
                    "[Knowledge] Skipping large file ({:.1} MB): {}",
                    fsize as f64 / (1024.0 * 1024.0),
                    file_path
                );
                append_skipped_file(workspace_root, file_path, "File exceeds 10 MB threshold");
                return Ok(());
            }

            // Incremental check: compare file hash to stored hash.
            let current_hash = storage::hash_file(file_path)
                .ok_or_else(|| format!("Could not hash file: {}", file_path))?;

            let mut hash_map = storage::read_file_hash_map(workspace_root);
            if let Some(stored_hash) = hash_map.get(file_path) {
                if *stored_hash == current_hash {
                    // File unchanged -- skip entirely.
                    return Ok(());
                }
            }

            // File is new or changed. Remove old data first.
            remove_file_data(workspace_root, file_path)?;

            // Parse the file.
            let parser = parser::parser_for_path(file_path)
                .ok_or_else(|| format!("No parser for: {}", file_path))?;

            let doc = match parser.parse(file_path) {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("[Knowledge] Parse failed for {}: {}", file_path, e);
                    // Propagate the error so it gets recorded in the UI status
                    return Err(format!("Parse failed: {}", e));
                }
            };

            // Chunk the parsed document.
            let chunks = chunker::chunk_document(doc);
            if chunks.is_empty() {
                return Ok(());
            }

            // Write chunks to disk.
            let chunk_ids: Vec<String> = chunks.iter().map(|c| c.id.clone()).collect();
            for chunk in &chunks {
                storage::write_chunk(workspace_root, chunk)
                    .map_err(|e| format!("Failed to write chunk {}: {}", chunk.id, e))?;
            }

            // Update file map.
            let mut file_map = storage::read_file_map(workspace_root);
            file_map.insert(file_path.to_string(), chunk_ids);
            storage::write_file_map(workspace_root, &file_map)
                .map_err(|e| format!("Failed to write file map: {}", e))?;

            // Update keyword index incrementally.
            let mut index = storage::read_keyword_index(workspace_root);
            indexer::add_chunks_to_index(&mut index, &chunks);
            storage::write_keyword_index(workspace_root, &index)
                .map_err(|e| format!("Failed to write keyword index: {}", e))?;

            // Update file hash.
            hash_map.insert(file_path.to_string(), current_hash);
            storage::write_file_hash_map(workspace_root, &hash_map)
                .map_err(|e| format!("Failed to write file hashes: {}", e))?;

            // Update manifest.
            let mut manifest = storage::read_manifest(workspace_root);
            manifest.file_count = file_map.len();
            manifest.chunk_count = file_map.values().map(|ids| ids.len()).sum();
            manifest.last_indexed = chrono_now_iso();
            storage::write_manifest(workspace_root, &manifest)
                .map_err(|e| format!("Failed to write manifest: {}", e))?;

            // Phase 2: rebuild scored keyword index (TF-IDF light).
            // This reuses the keyword index already in memory, so no extra disk read.
            let scored = indexer::rebuild_scored_index(&index, manifest.chunk_count);
            storage::write_scored_index(workspace_root, &scored)
                .map_err(|e| format!("Failed to write scored index: {}", e))?;

            // Phase 2: rebuild topic map from chunk headings.
            let topic_map = topics::build_topic_map(workspace_root);
            storage::write_topics(workspace_root, &topic_map)
                .map_err(|e| format!("Failed to write topics: {}", e))?;

            rebuild_note_metadata(workspace_root)?;

            println!(
                "[Knowledge] Indexed {} ({} chunks)",
                file_path,
                chunks.len()
            );
        }
    }

    Ok(())
}

/// Remove all stored data for a single file: chunks, file_map entry,
/// keyword index entries, and file hash entry.
fn remove_file_data(workspace_root: &str, file_path: &str) -> Result<(), String> {
    let mut file_map = storage::read_file_map(workspace_root);
    let chunk_ids = file_map.remove(file_path).unwrap_or_default();

    // Delete chunk files from disk.
    for id in &chunk_ids {
        let _ = storage::delete_chunk(workspace_root, id);
    }

    // Remove from keyword index.
    let mut index = storage::read_keyword_index(workspace_root);
    indexer::remove_chunks_from_index(&mut index, &chunk_ids);
    storage::write_keyword_index(workspace_root, &index)
        .map_err(|e| format!("Failed to write keyword index: {}", e))?;

    // Persist updated file map.
    storage::write_file_map(workspace_root, &file_map)
        .map_err(|e| format!("Failed to write file map: {}", e))?;

    // Remove file hash.
    let mut hash_map = storage::read_file_hash_map(workspace_root);
    hash_map.remove(file_path);
    storage::write_file_hash_map(workspace_root, &hash_map)
        .map_err(|e| format!("Failed to write file hashes: {}", e))?;

    // Update manifest.
    let mut manifest = storage::read_manifest(workspace_root);
    manifest.file_count = file_map.len();
    manifest.chunk_count = file_map.values().map(|ids| ids.len()).sum();
    manifest.last_indexed = chrono_now_iso();
    storage::write_manifest(workspace_root, &manifest)
        .map_err(|e| format!("Failed to write manifest: {}", e))?;

    let scored = indexer::rebuild_scored_index(&index, manifest.chunk_count);
    storage::write_scored_index(workspace_root, &scored)
        .map_err(|e| format!("Failed to write scored index: {}", e))?;
    let topic_map = topics::build_topic_map(workspace_root);
    storage::write_topics(workspace_root, &topic_map)
        .map_err(|e| format!("Failed to write topics: {}", e))?;
    rebuild_note_metadata(workspace_root)?;

    Ok(())
}

fn append_skipped_file(workspace_root: &str, file_path: &str, reason: &str) {
    let mut skipped = storage::read_skipped_files(workspace_root);
    skipped.push(SkippedFile {
        file: file_path.to_string(),
        reason: reason.to_string(),
        timestamp: chrono_now_iso(),
    });
    if skipped.len() > 200 {
        let drain_to = skipped.len() - 200;
        skipped.drain(0..drain_to);
    }
    let _ = storage::write_skipped_files(workspace_root, &skipped);
}

fn should_ignore_for_knowledge(workspace_root: &str, file_path: &str) -> bool {
    let normalized = file_path.replace('\\', "/").to_lowercase();
    let built_in = ["/.hibiscus/", "/.git/", "/node_modules/", "/.vscode/", "/__pycache__/"];
    if built_in.iter().any(|pat| normalized.contains(pat)) {
        return true;
    }

    let file_name = std::path::Path::new(file_path).file_name().and_then(|n| n.to_str()).unwrap_or("");
    if file_name.starts_with("~$") || file_name.starts_with(".~") {
        return true;
    }

    let ignore_path = std::path::Path::new(workspace_root).join(".hibiscusignore");
    let Ok(contents) = std::fs::read_to_string(ignore_path) else {
        return false;
    };
    let rel = normalized
        .strip_prefix(&workspace_root.replace('\\', "/").to_lowercase())
        .unwrap_or(&normalized)
        .trim_start_matches('/')
        .to_string();
    contents.lines().any(|line| {
        let pattern = line.trim();
        if pattern.is_empty() || pattern.starts_with('#') {
            return false;
        }
        let pattern = pattern.trim_matches('/').to_lowercase();
        rel.contains(&pattern) || normalized.contains(&pattern)
    })
}

fn rebuild_note_metadata(workspace_root: &str) -> Result<(), String> {
    let file_map = storage::read_file_map(workspace_root);
    let mut note_index: NoteIndex = HashMap::new();

    for (file, chunk_ids) in &file_map {
        let mut meta = NoteMetadata {
            path: file.clone(),
            name: display_name(file),
            title: None,
            tags: Vec::new(),
            aliases: Vec::new(),
            links: Vec::new(),
            resolved_links: Vec::new(),
            backlinks: Vec::new(),
            broken_links: Vec::new(),
            orphan: false,
        };
        for chunk_id in chunk_ids {
            if let Some(chunk) = storage::read_chunk(workspace_root, chunk_id) {
                if meta.title.is_none() {
                    meta.title = chunk.heading.clone();
                }
                extend_unique(&mut meta.tags, &chunk.tags);
                extend_unique(&mut meta.aliases, &chunk.aliases);
                extend_unique(&mut meta.links, &chunk.links);
            }
        }
        note_index.insert(file.clone(), meta);
    }

    let mut lookup: HashMap<String, String> = HashMap::new();
    for (path, meta) in &note_index {
        lookup.insert(meta.name.to_lowercase(), path.clone());
        for alias in &meta.aliases {
            lookup.insert(alias.to_lowercase(), path.clone());
        }
    }

    let mut backlinks: BacklinkMap = HashMap::new();
    let paths: Vec<String> = note_index.keys().cloned().collect();
    for source in paths {
        let links = note_index.get(&source).map(|m| m.links.clone()).unwrap_or_default();
        for link in links {
            if let Some(target) = resolve_link_target(&link, &lookup, &note_index) {
                if target != source {
                    push_unique(backlinks.entry(target.clone()).or_default(), source.clone());
                    if let Some(meta) = note_index.get_mut(&source) {
                        push_unique(&mut meta.resolved_links, target);
                    }
                }
            } else if let Some(meta) = note_index.get_mut(&source) {
                push_unique(&mut meta.broken_links, link);
            }
        }
    }

    for (target, sources) in &backlinks {
        if let Some(meta) = note_index.get_mut(target) {
            meta.backlinks = sources.clone();
        }
    }

    for meta in note_index.values_mut() {
        meta.orphan = meta.links.is_empty() && meta.backlinks.is_empty();
    }

    let graph = build_graph_from_metadata(&note_index);
    storage::write_note_index(workspace_root, &note_index)
        .map_err(|e| format!("Failed to write note metadata: {}", e))?;
    storage::write_backlinks(workspace_root, &backlinks)
        .map_err(|e| format!("Failed to write backlinks: {}", e))?;
    storage::write_graph(workspace_root, &graph)
        .map_err(|e| format!("Failed to write graph: {}", e))?;
    Ok(())
}

fn display_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

fn extend_unique(target: &mut Vec<String>, values: &[String]) {
    for value in values {
        push_unique(target, value.clone());
    }
}

fn push_unique(target: &mut Vec<String>, value: String) {
    if !target.contains(&value) {
        target.push(value);
    }
}

fn resolve_link_target(
    link: &str,
    lookup: &HashMap<String, String>,
    note_index: &NoteIndex,
) -> Option<String> {
    let lower = link.to_lowercase();
    if link.contains('/') || link.contains('\\') {
        let normalized = lower.replace('\\', "/");
        return note_index.keys().find_map(|path| {
            let candidate = path.to_lowercase().replace('\\', "/");
            let without_ext = candidate.trim_end_matches(".md").trim_end_matches(".markdown").trim_end_matches(".txt");
            if without_ext.ends_with(&normalized) {
                Some(path.clone())
            } else {
                None
            }
        });
    }
    lookup.get(&lower).cloned()
}

fn build_graph_from_metadata(note_index: &NoteIndex) -> KnowledgeGraph {
    let mut degree: HashMap<String, usize> = HashMap::new();
    let mut edges = Vec::new();
    let mut seen = HashSet::new();
    for (source, meta) in note_index {
        for target in &meta.resolved_links {
            let key = format!("{}->{}", source, target);
            if seen.insert(key) {
                *degree.entry(source.clone()).or_insert(0) += 1;
                *degree.entry(target.clone()).or_insert(0) += 1;
                edges.push(KnowledgeGraphEdge {
                    source: source.clone(),
                    target: target.clone(),
                });
            }
        }
    }

    let nodes = note_index.values().map(|meta| KnowledgeGraphNode {
        id: meta.path.clone(),
        label: meta.title.clone().unwrap_or_else(|| meta.name.clone()),
        tags: meta.tags.clone(),
        degree: degree.get(&meta.path).copied().unwrap_or(0),
    }).collect();

    KnowledgeGraph { nodes, edges }
}

/// Check if a file path has an indexable extension.
/// Phase 2 adds .pdf and .docx to the supported set.
fn is_indexable_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".txt")
        || lower.ends_with(".pdf")
        || lower.ends_with(".docx")
}

/// Produce a UTC ISO-8601 timestamp string without pulling in the `chrono` crate.
/// Uses `SystemTime` which is available in std.
fn chrono_now_iso() -> String {
    use std::time::SystemTime;

    match SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) {
        Ok(d) => {
            let secs = d.as_secs();
            // Simple UTC timestamp: good enough for manifest metadata.
            // Full ISO-8601 would require calendar math; we use Unix epoch seconds
            // as an unambiguous, sortable timestamp.
            format!("{}", secs)
        }
        Err(_) => "0".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Initial indexing: scan workspace and index all existing files
// ---------------------------------------------------------------------------

/// Scan the workspace for all indexable files and process them.
/// Called when a workspace is first opened or when a full reindex is requested.
///
/// This is NOT a "full rebuild" of the index -- it uses the same incremental
/// hash-based skip logic as event-driven updates. Files that are already
/// indexed and unchanged will be skipped.
pub fn initial_scan(workspace_root: &str) -> Result<usize, String> {
    storage::ensure_dirs(workspace_root)
        .map_err(|e| format!("Failed to create storage dirs: {}", e))?;
    let mut manifest = storage::read_manifest(workspace_root);
    manifest.schema_version = current_schema_version();
    manifest.index_state = "Indexing".to_string();
    manifest.last_rebuild = chrono_now_iso();
    storage::write_manifest(workspace_root, &manifest)
        .map_err(|e| format!("Failed to write manifest: {}", e))?;

    let mut count = 0;
    scan_directory(workspace_root, workspace_root, &mut count)?;
    let mut manifest = storage::read_manifest(workspace_root);
    manifest.schema_version = current_schema_version();
    manifest.index_state = "Ready".to_string();
    manifest.last_rebuild = chrono_now_iso();
    storage::write_manifest(workspace_root, &manifest)
        .map_err(|e| format!("Failed to write manifest: {}", e))?;
    Ok(count)
}

/// Recursively scan a directory for indexable files.
fn scan_directory(
    workspace_root: &str,
    dir_path: &str,
    count: &mut usize,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir_path)
        .map_err(|e| format!("Failed to read directory {}: {}", dir_path, e))?;

    // Collect file paths that need processing, avoiding holding the
    // directory iterator open during processing.
    let mut files_to_process: Vec<String> = Vec::new();
    let mut subdirs: Vec<String> = Vec::new();

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let path_str = path.to_string_lossy().to_string();

        // Skip ignored directories.
        if should_ignore_for_knowledge(workspace_root, &path_str) {
            continue;
        }

        if path.is_dir() {
            subdirs.push(path_str);
        } else if is_indexable_file(&path_str) {
            files_to_process.push(path_str);
        }
    }

    // Process files in this directory.
    for file_path in files_to_process {
        match process_file_event(workspace_root, &file_path, &FileEventType::Create) {
            Ok(()) => *count += 1,
            Err(e) => eprintln!("[Knowledge] Scan error for {}: {}", file_path, e),
        }
    }

    // Recurse into subdirectories.
    for subdir in subdirs {
        scan_directory(workspace_root, &subdir, count)?;
    }

    Ok(())
}
