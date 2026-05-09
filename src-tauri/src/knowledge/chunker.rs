//! ============================================================================
//! Chunking Engine
//! ============================================================================
//!
//! Splits `ParsedDocument` sections into size-bounded `Chunk` values.
//!
//! RULES:
//! - Each chunk is 200-500 words (target range).
//! - Heading context is preserved: every chunk inherits the heading of the
//!   section it was extracted from.
//! - Chunks NEVER cross file boundaries (enforced by processing one
//!   `ParsedDocument` at a time).
//!
//! PERFORMANCE:
//! - Word counting uses `split_ascii_whitespace()` which is a single-pass
//!   iterator -- no regex, no allocation of intermediate vectors.
//! - Chunk IDs are computed via a truncated SHA-256 of (file_path + content).
//!   We use the `std` hasher as a lightweight stand-in since we do not need
//!   cryptographic strength; however we keep the interface compatible with
//!   swapping to a real SHA-256 later if needed.
//! ============================================================================

use crate::knowledge::types::{Chunk, ParsedDocument};
use sha2::{Digest, Sha256};

/// Minimum word count per chunk. Sections smaller than this are emitted as-is
/// rather than being merged (merging across headings would lose context).
const MIN_WORDS: usize = 200;

/// Maximum word count per chunk. Sections larger than this are split at word
/// boundaries to stay within the budget.
const MAX_WORDS: usize = 500;

/// Produce a deterministic chunk ID from a file path and content string.
fn compute_chunk_id(file_path: &str, content: &str) -> String {
    stable_hash(&format!("{}\n{}", file_path, content))[..16].to_string()
}

/// Produce a content hash for change detection.
fn compute_content_hash(content: &str) -> String {
    stable_hash(content)
}

fn stable_hash(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn extract_wiki_links(content: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        if let Some(end) = after.find("]]" ) {
            let target = after[..end].trim();
            if !target.is_empty() && !links.iter().any(|l| l == target) {
                links.push(target.to_string());
            }
            rest = &after[end + 2..];
        } else {
            break;
        }
    }
    links
}

fn extract_tags(content: &str) -> Vec<String> {
    let mut tags = Vec::new();
    for token in content.split_whitespace() {
        let cleaned = token.trim_matches(|c: char| !c.is_alphanumeric() && c != '#' && c != '-' && c != '_');
        if let Some(tag) = cleaned.strip_prefix('#') {
            if tag.len() > 1 && tag.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
                let tag = tag.to_string();
                if !tags.contains(&tag) {
                    tags.push(tag);
                }
            }
        }
    }
    tags
}

fn extract_aliases(content: &str) -> Vec<String> {
    let mut aliases = Vec::new();
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return aliases;
    }
    let mut in_frontmatter = false;
    for line in trimmed.lines() {
        let line = line.trim();
        if line == "---" {
            if in_frontmatter { break; }
            in_frontmatter = true;
            continue;
        }
        if !in_frontmatter { continue; }
        if let Some(value) = line.strip_prefix("aliases:") {
            for part in value.trim().trim_matches(['[', ']']).split(',') {
                let alias = part.trim().trim_matches(['\"', '\'']).to_string();
                if !alias.is_empty() && !aliases.contains(&alias) {
                    aliases.push(alias);
                }
            }
        }
    }
    if aliases.is_empty() {
        if let Some(start) = trimmed.find("aliases:") {
            let after = &trimmed[start + "aliases:".len()..];
            let value = after
                .split("---")
                .next()
                .unwrap_or(after)
                .trim()
                .trim_matches(['[', ']']);
            for part in value.split(',') {
                let alias = part.trim().trim_matches(['"', '\'']).to_string();
                if !alias.is_empty() && !aliases.contains(&alias) {
                    aliases.push(alias);
                }
            }
        }
    }
    aliases
}

fn make_chunk(file_path: &str, heading: Option<String>, text: String, word_count: usize, section: &crate::knowledge::types::Section) -> Chunk {
    let id = compute_chunk_id(file_path, &text);
    let hash = compute_content_hash(&text);
    let (start_line, end_line) = section
        .start_line
        .zip(section.end_line)
        .unwrap_or_else(|| locate_line_range(file_path, &text).unwrap_or((1, 1)));
    Chunk {
        id,
        file: file_path.to_string(),
        heading,
        word_count,
        links: extract_wiki_links(&text),
        tags: extract_tags(&text),
        aliases: extract_aliases(&text),
        start_line: Some(start_line),
        end_line: Some(end_line),
        start_byte: section.start_byte,
        end_byte: section.end_byte,
        content: text,
        hash,
    }
}

fn locate_line_range(file_path: &str, text: &str) -> Option<(usize, usize)> {
    let file_text = std::fs::read_to_string(file_path).ok()?;
    let needle = text.split_whitespace().take(8).collect::<Vec<_>>().join(" ");
    if needle.is_empty() {
        return None;
    }
    for (idx, line) in file_text.lines().enumerate() {
        if line.contains(needle.split_whitespace().next().unwrap_or("")) {
            let line_no = idx + 1;
            let line_count = text.lines().count().max(1);
            return Some((line_no, line_no + line_count - 1));
        }
    }
    None
}

/// Split a `ParsedDocument` into a vector of `Chunk` values.
///
/// Each section is independently chunked:
/// - If the section has <= MAX_WORDS words, it becomes a single chunk.
/// - If the section exceeds MAX_WORDS, it is split at word boundaries into
///   sub-chunks of approximately MAX_WORDS words each. The last sub-chunk
///   may be smaller than MIN_WORDS if the remainder is small.
///
/// This function consumes the `ParsedDocument` to avoid unnecessary cloning.
pub fn chunk_document(doc: ParsedDocument) -> Vec<Chunk> {
    let file_path = doc.file_path;
    let mut chunks = Vec::new();

    for section in doc.sections {
        let content = section.content.trim();
        if content.is_empty() {
            continue;
        }

        let words: Vec<&str> = content.split_ascii_whitespace().collect();
        let total_words = words.len();

        if total_words <= MAX_WORDS {
            // Section fits in a single chunk -- emit directly.
            let text = words.join(" ");
            chunks.push(make_chunk(&file_path, section.heading.clone(), text, total_words, &section));
        } else {
            // Section exceeds MAX_WORDS: split into sub-chunks.
            // We walk through the word list in MAX_WORDS-sized windows.
            let mut offset = 0;
            while offset < total_words {
                let end = std::cmp::min(offset + MAX_WORDS, total_words);
                // If the remaining tail is very small (< MIN_WORDS / 2),
                // absorb it into the current chunk to avoid tiny fragments.
                let adjusted_end = if end < total_words && (total_words - end) < MIN_WORDS / 2 {
                    total_words
                } else {
                    end
                };
                let sub_words = &words[offset..adjusted_end];
                let text = sub_words.join(" ");
                chunks.push(make_chunk(&file_path, section.heading.clone(), text, sub_words.len(), &section));
                offset = adjusted_end;
            }
        }
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::types::Section;

    #[test]
    fn test_small_section_single_chunk() {
        let doc = ParsedDocument {
            file_path: "test.md".into(),
            sections: vec![Section {
                heading: Some("Intro".into()),
                content: "Hello world this is a test.".into(),
                ..Default::default()
            }],
        };
        let chunks = chunk_document(doc);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].heading.as_deref(), Some("Intro"));
        assert_eq!(chunks[0].word_count, 6);
    }

    #[test]
    fn test_large_section_splits() {
        // Create a section with 600 words (exceeds MAX_WORDS).
        let words: String = (0..600).map(|i| format!("word{}", i)).collect::<Vec<_>>().join(" ");
        let doc = ParsedDocument {
            file_path: "test.md".into(),
            sections: vec![Section {
                heading: None,
                content: words,
                ..Default::default()
            }],
        };
        let chunks = chunk_document(doc);
        assert!(chunks.len() >= 2);
        // All chunks should reference the same file.
        for c in &chunks {
            assert_eq!(c.file, "test.md");
        }
    }

    #[test]
    fn test_empty_section_skipped() {
        let doc = ParsedDocument {
            file_path: "test.md".into(),
            sections: vec![Section {
                heading: Some("Empty".into()),
                content: "   ".into(),
                ..Default::default()
            }],
        };
        let chunks = chunk_document(doc);
        assert!(chunks.is_empty());
    }

    #[test]
    fn test_deterministic_ids() {
        let doc1 = ParsedDocument {
            file_path: "a.md".into(),
            sections: vec![Section {
                heading: None,
                content: "same content".into(),
                ..Default::default()
            }],
        };
        let doc2 = ParsedDocument {
            file_path: "a.md".into(),
            sections: vec![Section {
                heading: None,
                content: "same content".into(),
                ..Default::default()
            }],
        };
        let c1 = chunk_document(doc1);
        let c2 = chunk_document(doc2);
        assert_eq!(c1[0].id, c2[0].id);
    }

    #[test]
    fn test_extracts_links_tags_and_aliases() {
        let doc = ParsedDocument {
            file_path: "a.md".into(),
            sections: vec![Section {
                heading: Some("Meta".into()),
                content: "---\naliases: [ML, machine learning]\n---\nSee [[Neural Nets]] #ai #study".into(),
                ..Default::default()
            }],
        };
        let chunks = chunk_document(doc);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].links.contains(&"Neural Nets".to_string()));
        assert!(chunks[0].tags.contains(&"ai".to_string()));
        assert!(chunks[0].aliases.contains(&"ML".to_string()));
    }
}
