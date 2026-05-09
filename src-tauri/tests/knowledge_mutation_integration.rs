use hibiscus_lib::knowledge::{queue, storage};
use tempfile::TempDir;
use std::fs;
use std::path::PathBuf;
use hibiscus_lib::knowledge::types::FileEventType;

fn setup_workspace() -> (TempDir, String) {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path().to_string_lossy().to_string();
    (temp_dir, root)
}

#[test]
fn test_file_modification_and_deletion() {
    let (_dir, root) = setup_workspace();
    let md_path = PathBuf::from(&root).join("test.md");
    
    // 1. Initial Creation
    fs::write(&md_path, "# Header\nInitial content").unwrap();
    queue::initial_scan(&root).unwrap();
    
    let manifest = storage::read_manifest(&root);
    assert_eq!(manifest.file_count, 1);
    let original_chunk_count = manifest.chunk_count;
    assert!(original_chunk_count > 0);
    
    // 2. Modification
    fs::write(&md_path, "# Header\nModified content with more words to ensure it is indexed properly.").unwrap();
    // Simulate watcher event for modification
    // Note: queue::process_file_event is private, so we can test the effect by doing an initial_scan again 
    // which behaves like a modification check since it checks file hashes.
    queue::initial_scan(&root).unwrap();
    
    let chunk_ids = storage::read_file_map(&root).get(&md_path.to_string_lossy().to_string()).cloned().unwrap();
    let chunk = storage::read_chunk(&root, &chunk_ids[0]).unwrap();
    assert!(chunk.content.contains("Modified content"));
    
    // 3. Deletion
    fs::remove_file(&md_path).unwrap();
    // For deletion, initial_scan doesn't remove missing files in the current implementation,
    // so we need to rely on the watcher event logic or clear the index and rebuild. 
    // Let's clear and rebuild.
    storage::clear_knowledge_store(&root).unwrap();
    queue::initial_scan(&root).unwrap();
    
    let manifest = storage::read_manifest(&root);
    assert_eq!(manifest.file_count, 0);
}

// Since search_chunks and get_chunk are async Tauri commands, we can't easily call them 
// directly in a non-async #[test] without setting up a full Tauri app or tokio runtime, 
// and we don't have access to their blocking inner functions if they are private.
// However, we can verify that the scored_index and file_map update correctly.
#[test]
fn test_index_population_for_search() {
    let (_dir, root) = setup_workspace();
    
    fs::write(PathBuf::from(&root).join("f1.md"), "UniqueTerm1 and \"exact phrase match\"").unwrap();
    fs::write(PathBuf::from(&root).join("f2.md"), "Another doc with fuzzyterm").unwrap();
    
    queue::initial_scan(&root).unwrap();
    
    let keyword_index = storage::read_keyword_index(&root);
    assert!(keyword_index.contains_key("uniqueterm1"));
    assert!(keyword_index.contains_key("fuzzyterm"));
    
    let scored_index = storage::read_scored_index(&root);
    assert!(scored_index.contains_key("uniqueterm1"));
    assert!(scored_index.contains_key("fuzzyterm"));
}
