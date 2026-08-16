//! ============================================================================
//! Hibiscus File Watcher Module
//! ============================================================================
//!
//! Filesystem watcher for detecting changes to workspace files.
//! Uses the `notify` crate for cross-platform file watching.
//!
//! FEATURES:
//! - Graceful shutdown mechanism (stop_watching command)
//! - Event filtering (ignores .hibiscus folder changes)
//! - Debounced events to prevent event storms
//! - Error recovery and logging
//! - Restartable (can switch workspaces)
//! - Knowledge indexing integration: forwards Create/Modify/Delete events
//!   to the knowledge queue for incremental indexing.
//!
//! ARCHITECTURE:
//! - Uses AtomicBool for thread-safe shutdown signaling
//! - Watcher runs in a dedicated thread to avoid blocking
//! - Events are emitted to the frontend via Tauri's event system
//! - Events are also forwarded to the knowledge indexing queue via
//!   an mpsc channel (fire-and-forget, non-blocking send)
//! ============================================================================

use crate::knowledge::types::{FileEvent, FileEventType};
use crate::knowledge::queue::KnowledgeState;
use notify::{event::{ModifyKind, RenameMode}, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, State};

/// State for managing the file watcher lifecycle.
///
/// This is registered as Tauri managed state, allowing commands
/// to control the watcher across different invocations.
pub struct WatcherState {
    /// Flag to signal the watcher thread to stop
    pub running: Arc<AtomicBool>,
    /// Path currently being watched (for logging)
    pub current_path: std::sync::Mutex<Option<String>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            current_path: std::sync::Mutex::new(None),
        }
    }
}

/// Debounce duration for filesystem events.
/// Events within this window are coalesced into a single notification.
const DEBOUNCE_MS: u64 = 300;

/// Timeout for checking shutdown signal.
/// Shorter timeouts mean faster shutdown response.
const RECV_TIMEOUT_MS: u64 = 100;

/// Paths to ignore when processing filesystem events.
/// These are patterns that should not trigger a refresh.
const IGNORED_PATHS: &[&str] = &[
    ".hibiscus",
    ".git",
    ".vscode",
    "node_modules",
    "__pycache__",
    ".DS_Store",
    "Thumbs.db",
];

/// Checks if a path should be ignored based on the IGNORED_PATHS list.
///
/// # Arguments
/// * `path` - The path to check
///
/// # Returns
/// `true` if the path contains any ignored pattern
fn should_ignore_path(path: &PathBuf) -> bool {
    let path_str = path.to_string_lossy();
    IGNORED_PATHS.iter().any(|pattern| path_str.contains(pattern))
}

fn classify_event_kind(kind: &EventKind) -> FileEventType {
    match kind {
        EventKind::Create(_) => FileEventType::Create,
        EventKind::Remove(_) => FileEventType::Delete,
        EventKind::Modify(ModifyKind::Name(RenameMode::From | RenameMode::To | RenameMode::Both | RenameMode::Any | RenameMode::Other)) => FileEventType::Rename,
        EventKind::Modify(_) => FileEventType::Modify,
        _ => FileEventType::Modify,
    }
}

/// Starts watching a workspace directory for filesystem changes.
///
/// This function spawns a background thread that monitors the specified
/// directory and emits "fs-changed" events when modifications are detected.
///
/// # Arguments
/// * `path` - The directory path to watch
/// * `window` - Tauri window handle for emitting events
/// * `state` - Managed state for controlling the watcher
///
/// # Events Emitted
/// * `fs-changed` - Emitted when relevant filesystem changes occur
///   Payload: Array of changed file paths
///
/// # Notes
/// - Calling this while a watcher is running will stop the old watcher first
/// - The watcher filters out changes to .hibiscus and other ignored paths
/// - Events are debounced to prevent excessive updates
#[tauri::command]
pub fn watch_workspace(
    path: String,
    window: tauri::Window,
    state: State<WatcherState>,
    knowledge_state: State<Arc<KnowledgeState>>,
) {
    // Clone the knowledge sender so the watcher thread can forward events.
    // This is a lightweight clone (Arc under the hood).
    let knowledge_sender = knowledge_state.sender.clone();

    // Set the workspace root for the knowledge system so the processing
    // pipeline knows where to read/write index data, then index everything
    // already present in the workspace.
    //
    // Previously only the workspace root was set here. Because the indexing
    // pipeline is purely event-driven, that meant a freshly opened workspace
    // stayed invisible to search/graph/topics until the user happened to edit
    // each file. The initial scan is hash-incremental, so re-opening a
    // workspace that is already indexed is cheap.
    {
        let ws_root = path.clone();
        let ks = (*knowledge_state).clone();
        let scan_window = window.clone();
        std::thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("[Knowledge] Could not start runtime for initial scan: {}", e);
                    return;
                }
            };

            rt.block_on(ks.set_workspace_root(ws_root.clone()));
            rt.block_on(ks.set_status_state("Indexing"));
            let _ = scan_window.emit("knowledge-indexing", true);

            match crate::knowledge::queue::initial_scan(&ws_root) {
                Ok(count) => println!("[Knowledge] Initial scan indexed {} file(s)", count),
                Err(e) => eprintln!("[Knowledge] Initial scan failed: {}", e),
            }

            rt.block_on(ks.set_status_state("Ready"));
            let _ = scan_window.emit("knowledge-indexing", false);
            // Tell the frontend the graph/backlinks/topics are worth re-fetching.
            let _ = scan_window.emit("knowledge-updated", ());
        });
    }
    // Stop any existing watcher
    state.running.store(false, Ordering::SeqCst);

    // Small delay to let the old watcher thread notice the shutdown
    std::thread::sleep(Duration::from_millis(RECV_TIMEOUT_MS * 2));

    // Update current path for logging
    if let Ok(mut current) = state.current_path.lock() {
        *current = Some(path.clone());
    }

    // Set running flag for new watcher
    let running = state.running.clone();
    running.store(true, Ordering::SeqCst);

    let watch_path = path.clone();
    let knowledge_tx = knowledge_sender;

    // Spawn watcher thread
    std::thread::spawn(move || {
        println!("[Hibiscus] Starting file watcher for: {}", watch_path);

        // Create channel for receiving filesystem events
        let (tx, rx) = channel();

        // Create the watcher
        let mut watcher: RecommendedWatcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[Hibiscus] Error: Failed to create file watcher: {}", e);
                running.store(false, Ordering::SeqCst);
                // Emit error event to frontend
                let _ = window.emit("fs-watcher-error", e.to_string());
                return;
            }
        };

        // Start watching the path
        if let Err(e) = watcher.watch(watch_path.as_ref(), RecursiveMode::Recursive) {
            eprintln!("[Hibiscus] Error: Failed to watch path '{}': {}", watch_path, e);
            running.store(false, Ordering::SeqCst);
            let _ = window.emit("fs-watcher-error", e.to_string());
            return;
        }

        println!("[Hibiscus] File watcher started successfully");

        // Accumulator for debouncing events
        let mut accumulated_paths = std::collections::HashMap::<String, FileEventType>::new();
        let mut last_event_time = Option::<Instant>::None;

        // Main event loop
        while running.load(Ordering::SeqCst) {
            // Determine timeout based on accumulation state
            let timeout = if accumulated_paths.is_empty() {
                Duration::from_millis(RECV_TIMEOUT_MS)
            } else {
                let elapsed = last_event_time.unwrap_or_else(Instant::now).elapsed();
                let debounce = Duration::from_millis(DEBOUNCE_MS);
                if elapsed >= debounce {
                    Duration::from_millis(0)
                } else {
                    debounce - elapsed
                }
            };

            match rx.recv_timeout(timeout) {
                Ok(Ok(event)) => {
                    // Filter and accumulate events
                    match event.kind {
                        EventKind::Access(_) | EventKind::Other => continue,
                        _ => {}
                    }
                    let knowledge_event_type = classify_event_kind(&event.kind);
                    for path in event.paths {
                        if !should_ignore_path(&path) {
                            accumulated_paths.insert(path.to_string_lossy().to_string(), knowledge_event_type.clone());
                        }
                    }
                    if !accumulated_paths.is_empty() {
                        last_event_time = Some(Instant::now());
                    }
                }
                Ok(Err(e)) => {
                    eprintln!("[Hibiscus] Warning: Watcher error: {}", e);
                }
                Err(RecvTimeoutError::Timeout) => {
                    // Check if we need to flush accumulated events
                    if !accumulated_paths.is_empty() {
                        if let Some(time) = last_event_time {
                            if time.elapsed() >= Duration::from_millis(DEBOUNCE_MS) {
                                let events: Vec<(String, FileEventType)> = accumulated_paths.drain().collect();
                                let paths: Vec<String> = events.iter().map(|(p, _)| p.clone()).collect();
                                if let Err(e) = window.emit("fs-changed", &paths) {
                                    eprintln!("[Hibiscus] Error emitting event: {}", e);
                                }
                                // Forward events to the knowledge indexing queue.
                                // We classify all debounced events as Modify since
                                // the debounce window may have coalesced Create+Modify.
                                // The knowledge pipeline handles this correctly: it
                                // uses hash-based change detection regardless of
                                // event type for Create/Modify.
                                for (p, event_type) in events {
                                    let _ = knowledge_tx.send(FileEvent {
                                        path: p,
                                        event_type,
                                    });
                                }
                                last_event_time = None;
                            }
                        }
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    eprintln!("[Hibiscus] Warning: Watcher channel disconnected");
                    break;
                }
            }
        }

        // Cleanup
        println!("[Hibiscus] File watcher stopped for: {}", watch_path);
        drop(watcher);
    });
}

/// Stops the current file watcher.
///
/// This command signals the watcher thread to stop gracefully.
/// Safe to call even if no watcher is running.
///
/// # Arguments
/// * `state` - Managed watcher state
#[tauri::command]
pub fn stop_watching(state: State<WatcherState>) {
    let was_running = state.running.swap(false, Ordering::SeqCst);

    if was_running {
        if let Ok(current) = state.current_path.lock() {
            if let Some(path) = current.as_ref() {
                println!("[Hibiscus] Stopping file watcher for: {}", path);
            }
        }
    }
}

/// Checks if a watcher is currently running.
///
/// # Arguments
/// * `state` - Managed watcher state
///
/// # Returns
/// `true` if a watcher is currently active
#[tauri::command]
pub fn is_watching(state: State<WatcherState>) -> bool {
    state.running.load(Ordering::SeqCst)
}

/// Gets the currently watched path, if any.
///
/// # Arguments
/// * `state` - Managed watcher state
///
/// # Returns
/// The watched path, or None if not watching
#[tauri::command]
pub fn get_watched_path(state: State<WatcherState>) -> Option<String> {
    if state.running.load(Ordering::SeqCst) {
        state.current_path.lock().ok().and_then(|p| p.clone())
    } else {
        None
    }
}
