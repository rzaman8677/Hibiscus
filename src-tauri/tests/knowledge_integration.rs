use hibiscus_lib::knowledge::{queue, storage};
use tempfile::TempDir;
use std::fs;
use std::path::PathBuf;

fn setup_workspace() -> (TempDir, String) {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path().to_string_lossy().to_string();
    (temp_dir, root)
}

#[test]
fn test_initial_indexing() {
    let (_dir, root) = setup_workspace();
    
    // Create a markdown file
    let md_path = PathBuf::from(&root).join("test1.md");
    fs::write(&md_path, "# Header\nHello world").unwrap();
    
    // Run initial scan
    let count = queue::initial_scan(&root).unwrap();
    assert_eq!(count, 1);
    
    let manifest = storage::read_manifest(&root);
    assert_eq!(manifest.file_count, 1);
    assert!(manifest.chunk_count > 0);
    assert_eq!(manifest.index_state, "Ready");
}

#[test]
fn test_hibiscusignore_exclusions() {
    let (_dir, root) = setup_workspace();
    
    fs::write(PathBuf::from(&root).join(".hibiscusignore"), "secret.md\nhidden_dir/").unwrap();
    fs::write(PathBuf::from(&root).join("public.md"), "Public content").unwrap();
    fs::write(PathBuf::from(&root).join("secret.md"), "Secret content").unwrap();
    
    fs::create_dir(PathBuf::from(&root).join("hidden_dir")).unwrap();
    fs::write(PathBuf::from(&root).join("hidden_dir/inner.md"), "Hidden content").unwrap();
    
    let count = queue::initial_scan(&root).unwrap();
    assert_eq!(count, 1); // Only public.md should be indexed
    
    let file_map = storage::read_file_map(&root);
    assert!(file_map.keys().any(|k| k.ends_with("public.md")));
    assert!(!file_map.keys().any(|k| k.ends_with("secret.md")));
}

#[test]
fn test_tags_aliases_wikilinks_backlinks() {
    let (_dir, root) = setup_workspace();
    
    let md1 = "---\naliases: [AI, ML]\n---\n# Topic\nIt uses #neural-nets and links to [[Doc2]].";
    fs::write(PathBuf::from(&root).join("doc1.md"), md1).unwrap();
    
    let md2 = "# Doc2\nTarget file.";
    fs::write(PathBuf::from(&root).join("doc2.md"), md2).unwrap();
    
    queue::initial_scan(&root).unwrap();
    
    let note_index = storage::read_note_index(&root);
    let backlinks = storage::read_backlinks(&root);
    let doc1_key = note_index.keys().find(|k| k.ends_with("doc1.md")).unwrap();
    let doc2_key = note_index.keys().find(|k| k.ends_with("doc2.md")).unwrap();
    
    let doc1_meta = &note_index[doc1_key];
    assert!(doc1_meta.tags.contains(&"neural-nets".to_string()));
    assert!(doc1_meta.aliases.contains(&"AI".to_string()));
    assert!(doc1_meta.aliases.contains(&"ML".to_string()));
    assert!(doc1_meta.links.contains(&"Doc2".to_string()));
    
    let doc2_backlinks = backlinks.get(doc2_key).unwrap();
    assert!(doc2_backlinks.contains(doc1_key));
}

#[test]
fn test_large_file_skipping() {
    let (_dir, root) = setup_workspace();
    
    // Create a 11MB file to trigger the LARGE_FILE_THRESHOLD
    let large_path = PathBuf::from(&root).join("large.md");
    let file = fs::File::create(&large_path).unwrap();
    file.set_len(11 * 1024 * 1024).unwrap();
    
    queue::initial_scan(&root).unwrap();
    
    let manifest = storage::read_manifest(&root);
    assert_eq!(manifest.file_count, 0); // Should be skipped
    
    let skipped = storage::read_skipped_files(&root);
    assert_eq!(skipped.len(), 1);
    assert!(skipped[0].file.ends_with("large.md"));
}

#[test]
fn test_topic_generation() {
    let (_dir, root) = setup_workspace();
    
    fs::write(PathBuf::from(&root).join("t1.md"), "# Apple\nApples are fruits").unwrap();
    fs::write(PathBuf::from(&root).join("t2.md"), "# Apple\nApple computers are devices").unwrap();
    
    queue::initial_scan(&root).unwrap();
    
    let topics = storage::read_topics(&root);
    // Topics should group chunks by their headings
    assert!(topics.contains_key("apple"));
    let chunks = topics.get("apple").unwrap();
    assert_eq!(chunks.len(), 2);
}
