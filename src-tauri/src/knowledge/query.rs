//! ============================================================================
//! Query API (Phase 1 + Phase 2)
//! ============================================================================
//!
//! Exposes Tauri commands for keyword search, chunk retrieval, and topic access.
//!
//! PHASE 1 COMMANDS (maintained for backward compatibility):
//! - `search_knowledge`: keyword -> matching chunk IDs + content.
//! - `get_chunk`: chunk_id -> full chunk data.
//! - `rebuild_knowledge_index`: triggers a full workspace scan.
//!
//! PHASE 2 COMMANDS:
//! - `search_chunks`: ranked keyword search with fuzzy and prefix matching.
//!   Returns results sorted by TF-IDF score with optional pagination.
//! - `get_topics`: returns the lightweight topic map.
//!
//! CACHING (Phase 2):
//! - An in-memory LRU cache (in KnowledgeState) is checked before disk access.
//! - Cache is invalidated on any file change event.
//!
//! RANKING ALGORITHM:
//!   final_score = keyword_score (from precomputed TF-IDF)
//!                 + 0.5 boost for exact keyword match
//!                 + 0.2 boost for prefix match
//!                 + 0.1 boost for fuzzy match (edit distance 1)
//!
//! PERFORMANCE:
//! - All scoring uses precomputed values from the scored index.
//! - No heavy computation at query time.
//! - Results are capped at top-K and support pagination.
//! - Early exit for large result sets.
//!
//! IMPORTANT: All commands are `async` so Tauri does not block the main
//! thread. CPU-bound work is done in `spawn_blocking`.
//! ============================================================================

use crate::knowledge::storage;
use crate::knowledge::types::{
    BacklinkMap, CachedQuery, KnowledgeError, KnowledgeGraph, KnowledgeStatus,
    RankedSearchResult, SearchResult, SkippedFile, TopicMap,
};
use crate::knowledge::queue::KnowledgeState;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;

/// Maximum number of recent queries to keep in the disk cache (Phase 1).
const MAX_CACHED_QUERIES: usize = 50;

/// Maximum number of results to consider before sorting (early exit bound).
/// Prevents scanning the entire index for very broad queries.
const MAX_CANDIDATE_RESULTS: usize = 500;

/// Score boost for exact keyword match (the query term appears verbatim).
const EXACT_MATCH_BOOST: f64 = 0.5;

/// Score boost for prefix match (a keyword starts with the query term).
const PREFIX_MATCH_BOOST: f64 = 0.2;

/// Score boost for fuzzy match (edit distance 1 from the query term).
const FUZZY_MATCH_BOOST: f64 = 0.1;
const PHRASE_MATCH_BOOST: f64 = 1.0;

#[derive(Debug, Clone)]
struct SearchFilters {
    topic: Option<String>,
    tags: Vec<String>,
    file_types: Vec<String>,
    folder: Option<String>,
    heading: Option<String>,
    mode: Option<String>,
}

// ===========================================================================
// Phase 1 commands (unchanged interface, maintained for backward compat)
// ===========================================================================

/// Search the knowledge index for chunks matching a keyword.
///
/// The keyword is normalized (lowercased, trimmed) before lookup.
/// Results include the full chunk content so the frontend does not need
/// a second round-trip to fetch each chunk.
///
/// # Arguments
/// * `keyword` - The search term.
/// * `state` - Knowledge managed state (provides workspace root).
///
/// # Returns
/// A list of `SearchResult` values, or an error string.
#[tauri::command]
pub async fn search_knowledge(
    keyword: String,
    state: State<'_, Arc<KnowledgeState>>,
) -> Result<Vec<SearchResult>, String> {
    let workspace_root = state
        .get_workspace_root()
        .await
        .ok_or_else(|| "No workspace root set".to_string())?;

    let normalized = keyword.trim().to_lowercase();
    if normalized.is_empty() {
        return Ok(Vec::new());
    }

    let ws = workspace_root.clone();
    let kw = normalized.clone();

    let result = tokio::task::spawn_blocking(move || {
        search_blocking(&ws, &kw)
    })
    .await
    .map_err(|e| format!("Search task failed: {}", e))?;

    result
}

/// Blocking implementation of keyword search (Phase 1).
/// Runs inside `spawn_blocking` to avoid blocking the async runtime.
fn search_blocking(workspace_root: &str, keyword: &str) -> Result<Vec<SearchResult>, String> {
    // Check cache.
    let cached = storage::read_recent_queries(workspace_root);
    if let Some(entry) = cached.iter().find(|q| q.keyword == keyword) {
        let results = load_search_results(workspace_root, &entry.chunk_ids);
        if !results.is_empty() {
            return Ok(results);
        }
    }

    // Cache miss or stale: look up the keyword index.
    let index = storage::read_keyword_index(workspace_root);
    let chunk_ids = match index.get(keyword) {
        Some(ids) => ids.clone(),
        None => return Ok(Vec::new()),
    };

    let results = load_search_results(workspace_root, &chunk_ids);

    // Update cache with new entry.
    let mut cached = cached;
    cached.retain(|q| q.keyword != keyword);
    cached.push(CachedQuery {
        keyword: keyword.to_string(),
        chunk_ids,
    });
    let _ = storage::write_recent_queries(workspace_root, &cached, MAX_CACHED_QUERIES);

    Ok(results)
}

/// Load chunks by ID and convert to SearchResult values.
/// Chunks that are missing or corrupt are silently skipped.
fn load_search_results(workspace_root: &str, chunk_ids: &[String]) -> Vec<SearchResult> {
    chunk_ids
        .iter()
        .filter_map(|id| {
            storage::read_chunk(workspace_root, id).map(|chunk| SearchResult {
                chunk_id: chunk.id,
                file: chunk.file,
                heading: chunk.heading,
                content: chunk.content,
                word_count: chunk.word_count,
                start_line: chunk.start_line,
                end_line: chunk.end_line,
                tags: chunk.tags,
            })
        })
        .collect()
}

/// Retrieve a single chunk by its ID.
#[tauri::command]
pub async fn get_chunk(
    chunk_id: String,
    state: State<'_, Arc<KnowledgeState>>,
) -> Result<SearchResult, String> {
    let workspace_root = state
        .get_workspace_root()
        .await
        .ok_or_else(|| "No workspace root set".to_string())?;

    // Phase 2: check in-memory chunk cache first.
    {
        let mut cache = state.cache.lock().await;
        if let Some(json_str) = cache.chunk_cache.get(&chunk_id) {
            if let Ok(result) = serde_json::from_str::<SearchResult>(&json_str) {
                return Ok(result);
            }
        }
    }

    let id = chunk_id.clone();
    let ws = workspace_root.clone();

    let result = tokio::task::spawn_blocking(move || {
        storage::read_chunk(&ws, &id)
            .map(|chunk| SearchResult {
                chunk_id: chunk.id,
                file: chunk.file,
                heading: chunk.heading,
                content: chunk.content,
                word_count: chunk.word_count,
                start_line: chunk.start_line,
                end_line: chunk.end_line,
                tags: chunk.tags,
            })
            .ok_or_else(|| format!("Chunk not found: {}", chunk_id))
    })
    .await
    .map_err(|e| format!("Get chunk task failed: {}", e))??;

    // Cache the result for future lookups.
    if let Ok(json_str) = serde_json::to_string(&result) {
        let mut cache = state.cache.lock().await;
        cache.chunk_cache.insert(result.chunk_id.clone(), json_str);
    }

    Ok(result)
}

/// Trigger a full workspace scan and re-index.
#[tauri::command]
pub async fn rebuild_knowledge_index(
    state: State<'_, Arc<KnowledgeState>>,
) -> Result<usize, String> {
    let workspace_root = state
        .get_workspace_root()
        .await
        .ok_or_else(|| "No workspace root set".to_string())?;

    // Invalidate all caches since the index is being rebuilt.
    {
        let mut cache = state.cache.lock().await;
        cache.invalidate_all();
    }

    let ws = workspace_root.clone();
    tokio::task::spawn_blocking(move || {
        storage::clear_knowledge_store(&ws)
            .map_err(|e| format!("Failed to clear stale knowledge index: {}", e))?;
        crate::knowledge::queue::initial_scan(&ws)
    })
    .await
    .map_err(|e| format!("Rebuild task failed: {}", e))?
}

#[tauri::command]
pub async fn clear_knowledge_index(
    state: State<'_, Arc<KnowledgeState>>,
) -> Result<(), String> {
    let workspace_root = state
        .get_workspace_root()
        .await
        .ok_or_else(|| "No workspace root set".to_string())?;
    {
        let mut cache = state.cache.lock().await;
        cache.invalidate_all();
    }
    let ws = workspace_root.clone();
    tokio::task::spawn_blocking(move || {
        storage::clear_knowledge_store(&ws)
            .map_err(|e| format!("Failed to clear knowledge index: {}", e))
    })
    .await
    .map_err(|e| format!("Clear task failed: {}", e))?
}

// ===========================================================================
// Phase 2 commands
// ===========================================================================

/// Ranked keyword search with fuzzy and prefix matching.
///
/// Uses the precomputed scored keyword index (TF-IDF) for instant ranking.
/// Supports pagination via `offset` and `limit` parameters.
///
/// # Ranking
/// For each query term, the engine:
/// 1. Checks for exact match in the scored index (full TF-IDF score).
/// 2. Scans for prefix matches (keywords starting with the query term).
/// 3. Scans for fuzzy matches (edit distance 1 from the query term).
///
/// Chunk scores are accumulated across all query terms. Results are sorted
/// by descending score and paginated.
///
/// # Arguments
/// * `query` - The search query string (may contain multiple words).
/// * `offset` - Number of results to skip (default 0).
/// * `limit` - Maximum number of results to return (default 20).
/// * `state` - Knowledge managed state.
///
/// # Returns
/// A list of `RankedSearchResult` values sorted by relevance score.
#[tauri::command]
pub async fn search_chunks(
    query: String,
    offset: Option<usize>,
    limit: Option<usize>,
    topic: Option<String>,
    tags: Option<Vec<String>>,
    file_types: Option<Vec<String>>,
    folder: Option<String>,
    heading: Option<String>,
    mode: Option<String>,
    state: State<'_, Arc<KnowledgeState>>,
) -> Result<Vec<RankedSearchResult>, String> {
    let workspace_root = state
        .get_workspace_root()
        .await
        .ok_or_else(|| "No workspace root set".to_string())?;

    let query_normalized = query.trim().to_lowercase();
    if query_normalized.is_empty() {
        return Ok(Vec::new());
    }

    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(20).min(100); // Cap at 100
    let filters = SearchFilters {
        topic,
        tags: tags.unwrap_or_default(),
        file_types: file_types.unwrap_or_default(),
        folder,
        heading,
        mode,
    };

    // Phase 2: check in-memory query cache first.
    let cache_key = format!("{}:{}:{}:{:?}", query_normalized, offset, limit, filters);
    {
        let mut cache = state.cache.lock().await;
        if let Some(cached_pairs) = cache.query_cache.get(&cache_key) {
            // Cache hit: load chunks by cached IDs and scores.
            let ws = workspace_root.clone();
            let pairs = cached_pairs.clone();
            let results = tokio::task::spawn_blocking(move || {
                load_ranked_results_from_pairs(&ws, &pairs)
            })
            .await
            .map_err(|e| format!("Cache load failed: {}", e))?;
            return Ok(results);
        }
    }

    let ws = workspace_root.clone();
    let qn = query_normalized.clone();

    let (ranked_pairs, results) = tokio::task::spawn_blocking(move || {
        ranked_search_blocking(&ws, &qn, offset, limit, &filters)
    })
    .await
    .map_err(|e| format!("Ranked search failed: {}", e))?;

    // Cache the result pairs (chunk_id, score) for future lookups.
    {
        let mut cache = state.cache.lock().await;
        cache.query_cache.insert(cache_key, ranked_pairs);
    }

    Ok(results)
}

/// Blocking implementation of ranked search.
/// Returns both the (chunk_id, score) pairs for caching and the full results.
fn ranked_search_blocking(
    workspace_root: &str,
    query: &str,
    offset: usize,
    limit: usize,
    filters: &SearchFilters,
) -> (Vec<(String, f64)>, Vec<RankedSearchResult>) {
    let scored_index = storage::read_scored_index(workspace_root);
    let phrases = extract_phrases(query);
    let topic_lookup = build_topic_lookup(workspace_root);
    let allowed_topic_chunks = filters.topic.as_ref().and_then(|topic| {
        storage::read_topics(workspace_root).get(topic).cloned()
    });

    // Split query into individual terms for multi-keyword search.
    let query_without_phrases = strip_phrases(query);
    let terms: Vec<&str> = query_without_phrases.split_ascii_whitespace().collect();
    if terms.is_empty() && phrases.is_empty() {
        return (Vec::new(), Vec::new());
    }

    // Accumulate scores per chunk across all query terms.
    let mut chunk_scores: HashMap<String, f64> = HashMap::new();

    for term in &terms {
        // 1. Exact match: full TF-IDF score + exact boost.
        if let Some(entry) = scored_index.get(*term) {
            for chunk_id in &entry.chunks {
                *chunk_scores.entry(chunk_id.clone()).or_insert(0.0)
                    += entry.score + EXACT_MATCH_BOOST;
            }
        }

        // 2. Prefix match: scan index for keywords starting with the term.
        // 3. Fuzzy match: scan index for keywords within edit distance 1.
        //
        // PERFORMANCE: This is a linear scan of the scored index keys.
        // For typical indices (10K-50K keywords), this completes in <1ms.
        // We skip the exact match key to avoid double-counting.
        let mut candidates_added = 0;
        for (keyword, entry) in &scored_index {
            if candidates_added >= MAX_CANDIDATE_RESULTS {
                break;
            }

            if keyword == *term {
                continue; // Already handled as exact match.
            }

            if keyword.starts_with(*term) {
                // Prefix match.
                for chunk_id in &entry.chunks {
                    *chunk_scores.entry(chunk_id.clone()).or_insert(0.0)
                        += entry.score * PREFIX_MATCH_BOOST;
                    candidates_added += 1;
                }
            } else if is_fuzzy_match(term, keyword) {
                // Fuzzy match (edit distance 1).
                for chunk_id in &entry.chunks {
                    *chunk_scores.entry(chunk_id.clone()).or_insert(0.0)
                        += entry.score * FUZZY_MATCH_BOOST;
                    candidates_added += 1;
                }
            }
        }
    }

    for phrase in &phrases {
        for chunk_id in candidate_chunk_ids(workspace_root) {
            if let Some(chunk) = storage::read_chunk(workspace_root, &chunk_id) {
                if chunk.content.to_lowercase().contains(phrase) {
                    *chunk_scores.entry(chunk_id).or_insert(0.0) += PHRASE_MATCH_BOOST;
                }
            }
        }
    }

    if chunk_scores.is_empty() {
        return (Vec::new(), Vec::new());
    }

    // Sort by score descending, then by chunk_id for determinism.
    let mut scored_chunks: Vec<(String, f64)> = chunk_scores
        .into_iter()
        .filter(|(chunk_id, _)| {
            if let Some(allowed) = &allowed_topic_chunks {
                if !allowed.contains(chunk_id) {
                    return false;
                }
            }
            chunk_matches_filters(workspace_root, chunk_id, filters)
        })
        .collect();
    scored_chunks.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });

    // Apply pagination.
    let paginated: Vec<(String, f64)> = scored_chunks
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect();

    // Load chunk data for the paginated results.
    let results = load_ranked_results_from_pairs_with_context(workspace_root, &paginated, &terms, &topic_lookup);

    (paginated, results)
}

/// Load chunks by (chunk_id, score) pairs and build RankedSearchResult values.
fn load_ranked_results_from_pairs(
    workspace_root: &str,
    pairs: &[(String, f64)],
) -> Vec<RankedSearchResult> {
    pairs
        .iter()
        .filter_map(|(chunk_id, score)| {
            storage::read_chunk(workspace_root, chunk_id).map(|chunk| RankedSearchResult {
                chunk_id: chunk.id,
                file: chunk.file,
                heading: chunk.heading,
                content: chunk.content,
                word_count: chunk.word_count,
                score: *score,
                start_line: chunk.start_line,
                end_line: chunk.end_line,
                matched_terms: Vec::new(),
                tags: chunk.tags,
                topic: None,
            })
        })
        .collect()
}

fn load_ranked_results_from_pairs_with_context(
    workspace_root: &str,
    pairs: &[(String, f64)],
    terms: &[&str],
    topic_lookup: &HashMap<String, String>,
) -> Vec<RankedSearchResult> {
    pairs
        .iter()
        .filter_map(|(chunk_id, score)| {
            storage::read_chunk(workspace_root, chunk_id).map(|chunk| {
                let content_lower = chunk.content.to_lowercase();
                let matched_terms = terms
                    .iter()
                    .filter(|term| content_lower.contains(**term))
                    .map(|term| (*term).to_string())
                    .collect();
                RankedSearchResult {
                    chunk_id: chunk.id.clone(),
                    file: chunk.file,
                    heading: chunk.heading,
                    content: chunk.content,
                    word_count: chunk.word_count,
                    score: *score,
                    start_line: chunk.start_line,
                    end_line: chunk.end_line,
                    matched_terms,
                    tags: chunk.tags,
                    topic: topic_lookup.get(&chunk.id).cloned(),
                }
            })
        })
        .collect()
}

fn extract_phrases(query: &str) -> Vec<String> {
    let mut phrases = Vec::new();
    let mut in_quote = false;
    let mut current = String::new();
    for ch in query.chars() {
        if ch == '"' {
            if in_quote {
                let phrase = current.trim().to_lowercase();
                if !phrase.is_empty() {
                    phrases.push(phrase);
                }
                current.clear();
            }
            in_quote = !in_quote;
        } else if in_quote {
            current.push(ch);
        }
    }
    phrases
}

fn strip_phrases(query: &str) -> String {
    let mut out = String::new();
    let mut in_quote = false;
    for ch in query.chars() {
        if ch == '"' {
            in_quote = !in_quote;
            out.push(' ');
        } else if !in_quote {
            out.push(ch);
        }
    }
    out
}

fn candidate_chunk_ids(workspace_root: &str) -> Vec<String> {
    storage::read_file_map(workspace_root)
        .values()
        .flat_map(|ids| ids.clone())
        .collect()
}

fn build_topic_lookup(workspace_root: &str) -> HashMap<String, String> {
    let mut lookup = HashMap::new();
    for (topic, chunk_ids) in storage::read_topics(workspace_root) {
        for chunk_id in chunk_ids {
            lookup.insert(chunk_id, topic.clone());
        }
    }
    lookup
}

fn chunk_matches_filters(workspace_root: &str, chunk_id: &str, filters: &SearchFilters) -> bool {
    let Some(chunk) = storage::read_chunk(workspace_root, chunk_id) else {
        return false;
    };
    if let Some(folder) = &filters.folder {
        if !chunk.file.replace('\\', "/").contains(&folder.replace('\\', "/")) {
            return false;
        }
    }
    if let Some(heading) = &filters.heading {
        if !chunk.heading.as_deref().unwrap_or("").to_lowercase().contains(&heading.to_lowercase()) {
            return false;
        }
    }
    if !filters.file_types.is_empty() {
        let ext = std::path::Path::new(&chunk.file)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !filters.file_types.iter().any(|ft| ft.trim_start_matches('.').eq_ignore_ascii_case(&ext)) {
            return false;
        }
    }
    if !filters.tags.is_empty() {
        let chunk_tags: Vec<String> = chunk.tags.iter().map(|t| t.to_lowercase()).collect();
        if !filters.tags.iter().all(|tag| chunk_tags.contains(&tag.to_lowercase())) {
            return false;
        }
    }
    let _reserved_mode = filters.mode.as_deref().unwrap_or("keyword");
    true
}

/// Lightweight fuzzy match: returns true if two strings differ by exactly
/// one character (insertion, deletion, or substitution).
///
/// This is a simplified Levenshtein distance check optimized for the common
/// case of short keywords (3-15 characters). It runs in O(max(m,n)) time
/// for strings of length m and n.
///
/// DESIGN: We only check edit distance = 1 because:
/// - Distance 0 = exact match (handled separately).
/// - Distance 1 = catches common typos (e.g., "rust" vs "rast").
/// - Distance 2+ = too many false positives for short keywords.
fn is_fuzzy_match(query: &str, keyword: &str) -> bool {
    let q_len = query.len();
    let k_len = keyword.len();

    // Edit distance > 1 is impossible if lengths differ by > 1.
    if q_len.abs_diff(k_len) > 1 {
        return false;
    }

    // Skip very short terms to avoid false positives.
    if q_len < 3 || k_len < 3 {
        return false;
    }

    let q_bytes = query.as_bytes();
    let k_bytes = keyword.as_bytes();

    if q_len == k_len {
        // Same length: check for exactly one substitution.
        let diffs = q_bytes.iter().zip(k_bytes.iter()).filter(|(a, b)| a != b).count();
        diffs == 1
    } else {
        // Different lengths: check for exactly one insertion/deletion.
        let (shorter, longer) = if q_len < k_len {
            (q_bytes, k_bytes)
        } else {
            (k_bytes, q_bytes)
        };

        let mut i = 0;
        let mut j = 0;
        let mut diffs = 0;

        while i < shorter.len() && j < longer.len() {
            if shorter[i] != longer[j] {
                diffs += 1;
                if diffs > 1 {
                    return false;
                }
                j += 1; // Skip one character in the longer string.
            } else {
                i += 1;
                j += 1;
            }
        }

        diffs <= 1
    }
}

/// Retrieve the topic map.
///
/// # Arguments
/// * `state` - Knowledge managed state.
///
/// # Returns
/// The topic map as a HashMap of topic name -> [chunk_ids].
#[tauri::command]
pub async fn get_topics(
    state: State<'_, Arc<KnowledgeState>>,
) -> Result<TopicMap, String> {
    let workspace_root = state
        .get_workspace_root()
        .await
        .ok_or_else(|| "No workspace root set".to_string())?;

    let ws = workspace_root.clone();
    tokio::task::spawn_blocking(move || {
        Ok(storage::read_topics(&ws))
    })
    .await
    .map_err(|e| format!("Get topics task failed: {}", e))?
}

#[tauri::command]
pub async fn get_knowledge_status(
    state: State<'_, Arc<KnowledgeState>>,
) -> Result<KnowledgeStatus, String> {
    let workspace_root = state
        .get_workspace_root()
        .await
        .ok_or_else(|| "No workspace root set".to_string())?;
    let ws = workspace_root.clone();
    tokio::task::spawn_blocking(move || Ok(storage::read_status(&ws)))
        .await
        .map_err(|e| format!("Get status task failed: {}", e))?
}

#[tauri::command]
pub async fn get_indexing_errors(
    state: State<'_, Arc<KnowledgeState>>,
) -> Result<Vec<KnowledgeError>, String> {
    let workspace_root = state
        .get_workspace_root()
        .await
        .ok_or_else(|| "No workspace root set".to_string())?;
    let ws = workspace_root.clone();
    tokio::task::spawn_blocking(move || Ok(storage::read_errors(&ws)))
        .await
        .map_err(|e| format!("Get errors task failed: {}", e))?
}

#[tauri::command]
pub async fn get_skipped_files(
    state: State<'_, Arc<KnowledgeState>>,
) -> Result<Vec<SkippedFile>, String> {
    let workspace_root = state
        .get_workspace_root()
        .await
        .ok_or_else(|| "No workspace root set".to_string())?;
    let ws = workspace_root.clone();
    tokio::task::spawn_blocking(move || Ok(storage::read_skipped_files(&ws)))
        .await
        .map_err(|e| format!("Get skipped files task failed: {}", e))?
}

#[tauri::command]
pub async fn get_knowledge_graph(
    state: State<'_, Arc<KnowledgeState>>,
) -> Result<KnowledgeGraph, String> {
    let workspace_root = state
        .get_workspace_root()
        .await
        .ok_or_else(|| "No workspace root set".to_string())?;
    let ws = workspace_root.clone();
    tokio::task::spawn_blocking(move || Ok(storage::read_graph(&ws)))
        .await
        .map_err(|e| format!("Get graph task failed: {}", e))?
}

/// Extract a document's text into an editable Markdown note beside it.
///
/// PDFs and DOCX files are opened read-only -- their bytes cannot be
/// round-tripped from a text editor without corrupting them. This command gives
/// the user the other half of that contract: the extracted content as a real
/// Markdown note they can edit, link with `[[wiki-links]]`, and which the
/// indexer then picks up like any other note.
///
/// Structure is preserved via the parsers' section headings (page numbers for
/// PDFs, Word heading styles for DOCX), so the note is navigable rather than
/// one undifferentiated wall of text.
///
/// # Returns
/// The absolute path of the note that was written.
#[tauri::command]
pub async fn extract_document_to_note(source_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || extract_to_note_blocking(&source_path))
        .await
        .map_err(|e| format!("Extraction task failed: {}", e))?
}

fn extract_to_note_blocking(source_path: &str) -> Result<String, String> {
    use std::path::Path;

    let parser = crate::knowledge::parser::parser_for_path(source_path)
        .ok_or_else(|| format!("No parser available for: {}", source_path))?;

    let doc = parser
        .parse(source_path)
        .map_err(|e| format!("Could not extract text: {}", e))?;

    let source = Path::new(source_path);
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    let parent = source.parent().ok_or_else(|| "Invalid source path".to_string())?;
    let source_name = source
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(source_path);

    // Build the note. Front matter records provenance so the extracted note can
    // always be traced back to the document it came from.
    let mut out = String::with_capacity(4096);
    out.push_str("---\n");
    out.push_str(&format!("source: \"{}\"\n", source_name.replace('"', "'")));
    out.push_str("extracted-by: hibiscus\n");
    out.push_str("---\n\n");
    out.push_str(&format!("# {}\n\n", stem));

    let mut last_heading: Option<String> = None;
    for section in &doc.sections {
        if section.content.trim().is_empty() {
            continue;
        }

        // Consecutive chunks from the same PDF page share a heading; only emit
        // it when it actually changes.
        if section.heading != last_heading {
            if let Some(heading) = &section.heading {
                out.push_str(&format!("## {}\n\n", heading.trim()));
            }
            last_heading = section.heading.clone();
        }

        out.push_str(section.content.trim());
        out.push_str("\n\n");
    }

    // Never clobber an existing note: pick the first free numbered variant.
    let mut target = parent.join(format!("{} (extracted).md", stem));
    let mut counter = 2;
    while target.exists() {
        target = parent.join(format!("{} (extracted {}).md", stem, counter));
        counter += 1;
        if counter > 999 {
            return Err("Too many extracted copies of this document".to_string());
        }
    }

    std::fs::write(&target, out)
        .map_err(|e| format!("Failed to write note '{}': {}", target.display(), e))?;

    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_backlinks(
    state: State<'_, Arc<KnowledgeState>>,
) -> Result<BacklinkMap, String> {
    let workspace_root = state
        .get_workspace_root()
        .await
        .ok_or_else(|| "No workspace root set".to_string())?;
    let ws = workspace_root.clone();
    tokio::task::spawn_blocking(move || Ok(storage::read_backlinks(&ws)))
        .await
        .map_err(|e| format!("Get backlinks task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fuzzy_match_substitution() {
        assert!(is_fuzzy_match("rust", "rast"));   // one substitution
        assert!(!is_fuzzy_match("rust", "rust"));  // identical = distance 0, not fuzzy
        assert!(is_fuzzy_match("test", "tast"));   // one substitution
    }

    #[test]
    fn test_fuzzy_match_insertion() {
        assert!(is_fuzzy_match("rust", "rusts")); // one insertion
        assert!(is_fuzzy_match("test", "tests")); // one insertion
    }

    #[test]
    fn test_fuzzy_match_too_different() {
        assert!(!is_fuzzy_match("rust", "java")); // too many differences
        assert!(!is_fuzzy_match("ab", "cd"));     // too short
    }

    #[test]
    fn test_fuzzy_match_length_difference() {
        assert!(!is_fuzzy_match("rust", "rustlang")); // length diff > 1
    }

    #[test]
    fn test_phrase_extraction_and_stripping() {
        assert_eq!(extract_phrases(r#"rust "dynamic programming" notes"#), vec!["dynamic programming"]);
        assert_eq!(strip_phrases(r#"rust "dynamic programming" notes"#).split_whitespace().collect::<Vec<_>>(), vec!["rust", "notes"]);
    }
}
