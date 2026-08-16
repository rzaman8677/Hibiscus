//! ============================================================================
//! Trait-Based Parser System
//! ============================================================================
//!
//! Provides a `Parser` trait and concrete implementations for Markdown and
//! plain-text files. The trait-based design allows adding new formats (e.g.
//! .org, .rst) without modifying existing code.
//!
//! FAILURE HANDLING:
//! - All parse errors are returned as `ParseError` -- the caller (worker pool)
//!   logs the error and skips the file. No panics.
//! - File reads use buffered I/O to keep memory usage proportional to file
//!   size, not the number of files being processed concurrently.
//!
//! PERFORMANCE:
//! - Markdown heading detection uses byte-level checks (starts_with '#')
//!   instead of regex, since we only need ATX-style headings.
//! - Paragraph splitting in the TXT parser uses a single pass over the string.
//! ============================================================================

use crate::knowledge::types::{ParseError, ParsedDocument, Section};
use std::io::{BufRead, BufReader};
use std::path::Path;

// ---------------------------------------------------------------------------
// Parser trait
// ---------------------------------------------------------------------------

/// Trait for file format parsers.
///
/// Each implementation handles a specific set of file extensions and
/// transforms raw file content into a sequence of `Section` values.
pub trait Parser {
    /// Returns `true` if this parser can handle files with the given extension.
    fn supports(&self, ext: &str) -> bool;

    /// Parse the file at `path` into a `ParsedDocument`.
    ///
    /// Implementations MUST:
    /// - Use buffered I/O (BufReader) for the file read.
    /// - Return `ParseError` on failure -- never panic.
    /// - Produce at least one section even for trivially small files.
    fn parse(&self, path: &str) -> Result<ParsedDocument, ParseError>;
}

// ---------------------------------------------------------------------------
// Markdown parser
// ---------------------------------------------------------------------------

/// Parses Markdown files by splitting on ATX-style headings (`#`, `##`, etc.).
///
/// Each heading starts a new section whose `heading` field contains the
/// heading text (without the `#` prefix). Content before the first heading
/// goes into a section with `heading: None`.
pub struct MarkdownParser;

impl Parser for MarkdownParser {
    fn supports(&self, ext: &str) -> bool {
        ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown")
    }

    fn parse(&self, path: &str) -> Result<ParsedDocument, ParseError> {
        let file = std::fs::File::open(path)
            .map_err(|e| ParseError::IoError(format!("{}: {}", path, e)))?;
        let reader = BufReader::new(file);

        let mut sections: Vec<Section> = Vec::new();
        let mut current_heading: Option<String> = None;
        // Pre-allocate a reasonable buffer; most sections are under 4 KB.
        let mut current_content = String::with_capacity(4096);

        for line_result in reader.lines() {
            let line = line_result
                .map_err(|e| ParseError::IoError(format!("{}: {}", path, e)))?;

            // Detect ATX headings: lines starting with one or more '#' followed
            // by a space. This is a byte-level check -- no regex needed.
            if line.starts_with('#') {
                // Count the heading level (number of leading '#' characters).
                let level_end = line.bytes().take_while(|&b| b == b'#').count();
                // A valid ATX heading requires a space after the '#' sequence,
                // or the line is exactly the '#' characters (empty heading).
                let rest = &line[level_end..];
                if rest.is_empty() || rest.starts_with(' ') {
                    // Flush the current section before starting a new one.
                    let trimmed = current_content.trim().to_string();
                    if !trimmed.is_empty() || current_heading.is_some() {
                        sections.push(Section {
                            heading: current_heading.take(),
                            content: trimmed,
                            ..Default::default()
                        });
                    }
                    current_heading = Some(rest.trim().to_string());
                    current_content.clear();
                    continue;
                }
            }

            // Accumulate content lines, separated by newlines.
            if !current_content.is_empty() {
                current_content.push('\n');
            }
            current_content.push_str(&line);
        }

        // Flush the last section.
        let trimmed = current_content.trim().to_string();
        if !trimmed.is_empty() || current_heading.is_some() {
            sections.push(Section {
                heading: current_heading,
                content: trimmed,
                ..Default::default()
            });
        }

        // Guarantee at least one section for non-empty files.
        if sections.is_empty() {
            sections.push(Section {
                heading: None,
                content: String::new(),
                ..Default::default()
            });
        }

        Ok(ParsedDocument {
            file_path: path.to_string(),
            sections,
        })
    }
}

// ---------------------------------------------------------------------------
// Plain-text parser
// ---------------------------------------------------------------------------

/// Parses plain-text files by splitting on blank-line-separated paragraphs.
///
/// Each paragraph becomes a `Section` with `heading: None`. This is the
/// simplest reasonable chunking strategy for unstructured text.
pub struct TxtParser;

impl Parser for TxtParser {
    fn supports(&self, ext: &str) -> bool {
        ext.eq_ignore_ascii_case("txt")
    }

    fn parse(&self, path: &str) -> Result<ParsedDocument, ParseError> {
        let file = std::fs::File::open(path)
            .map_err(|e| ParseError::IoError(format!("{}: {}", path, e)))?;
        let reader = BufReader::new(file);

        let mut sections: Vec<Section> = Vec::new();
        let mut current_paragraph = String::with_capacity(4096);

        for line_result in reader.lines() {
            let line = line_result
                .map_err(|e| ParseError::IoError(format!("{}: {}", path, e)))?;

            if line.trim().is_empty() {
                // Blank line: flush the current paragraph as a section.
                let trimmed = current_paragraph.trim().to_string();
                if !trimmed.is_empty() {
                    sections.push(Section {
                        heading: None,
                        content: trimmed,
                        ..Default::default()
                    });
                    current_paragraph.clear();
                }
            } else {
                if !current_paragraph.is_empty() {
                    current_paragraph.push('\n');
                }
                current_paragraph.push_str(&line);
            }
        }

        // Flush the last paragraph.
        let trimmed = current_paragraph.trim().to_string();
        if !trimmed.is_empty() {
            sections.push(Section {
                heading: None,
                content: trimmed,
                ..Default::default()
            });
        }

        if sections.is_empty() {
            sections.push(Section {
                heading: None,
                content: String::new(),
                ..Default::default()
            });
        }

        Ok(ParsedDocument {
            file_path: path.to_string(),
            sections,
        })
    }
}

// ---------------------------------------------------------------------------
// PDF parser (Phase 2)
// ---------------------------------------------------------------------------

/// Parses PDF files by extracting raw text content.
///
/// Uses the `pdf-extract` crate for text extraction. The entire PDF text is
/// extracted as a single string, then split into sections by double-newlines
/// (paragraph breaks). This is a best-effort strategy since PDF layout is
/// inherently non-semantic.
///
/// FAILURE HANDLING: Corrupted or encrypted PDFs are caught and returned as
/// `ParseError::IoError`. The pipeline will skip the file and continue.
///
/// PERFORMANCE: `pdf_extract::extract_text` reads the file in a single pass.
/// This is acceptable because PDF parsing is always deferred to
/// `spawn_blocking` and large files are filtered at the queue level.
pub struct PdfParser;

/// Clean up text extracted from a PDF.
///
/// PDF extraction commonly emits hard line breaks mid-sentence (from the
/// original layout) and hyphenated word splits at line ends. Left as-is these
/// fragment the keyword index -- "knowl-\nedge" never matches "knowledge" --
/// so we rejoin them before chunking.
fn normalize_pdf_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut lines = raw.lines().map(str::trim).filter(|l| !l.is_empty()).peekable();

    while let Some(line) = lines.next() {
        if let Some(stripped) = line.strip_suffix('-') {
            // Hyphenated split across lines: join without a space.
            out.push_str(stripped);
            continue;
        }

        out.push_str(line);
        if lines.peek().is_some() {
            out.push(' ');
        }
    }

    out.trim().to_string()
}

impl Parser for PdfParser {
    fn supports(&self, ext: &str) -> bool {
        ext.eq_ignore_ascii_case("pdf")
    }

    fn parse(&self, path: &str) -> Result<ParsedDocument, ParseError> {
        let file = std::fs::File::open(path)
            .map_err(|e| ParseError::IoError(format!("{}: {}", path, e)))?;

        // Handle empty files without crashing the PDF extractor
        if file.metadata().map(|m| m.len()).unwrap_or(0) == 0 {
            return Ok(ParsedDocument {
                file_path: path.to_string(),
                sections: vec![Section {
                    heading: None,
                    content: String::new(),
                    ..Default::default()
                }],
            });
        }

        // Extract per page rather than as one flat blob. Page provenance is the
        // only locator a PDF has -- without it, a search hit in a 300-page book
        // gives the user no way to find the passage. The page number is carried
        // as the section heading so it flows through chunking, search results
        // and topic grouping unchanged.
        let pages = pdf_extract::extract_text_by_pages(path)
            .map_err(|e| ParseError::IoError(format!("{}: PDF extraction failed: {}", path, e)))?;

        let mut sections: Vec<Section> = Vec::new();

        for (page_index, page_text) in pages.iter().enumerate() {
            let page_label = format!("Page {}", page_index + 1);

            // PDF text extraction produces erratic whitespace; treat any run of
            // 2+ newlines as a paragraph break within the page.
            for paragraph in page_text.split("\n\n") {
                let trimmed = normalize_pdf_text(paragraph);
                if !trimmed.is_empty() {
                    sections.push(Section {
                        heading: Some(page_label.clone()),
                        content: trimmed,
                        ..Default::default()
                    });
                }
            }
        }

        if sections.is_empty() {
            sections.push(Section {
                heading: None,
                content: String::new(),
                ..Default::default()
            });
        }

        Ok(ParsedDocument {
            file_path: path.to_string(),
            sections,
        })
    }
}

// ---------------------------------------------------------------------------
// DOCX parser (Phase 2)
// ---------------------------------------------------------------------------

/// Parses DOCX files by extracting paragraph text from the embedded XML.
///
/// A DOCX file is a ZIP archive containing `word/document.xml`. This parser:
/// 1. Opens the ZIP archive.
/// 2. Locates `word/document.xml`.
/// 3. Parses the XML using `quick-xml` in streaming mode.
/// 4. Extracts text from `<w:t>` elements, grouping by `<w:p>` (paragraph).
///
/// DESIGN: We use `quick-xml` directly rather than a higher-level DOCX crate
/// to minimize dependencies and maintain full control over memory allocation.
/// Streaming XML parsing keeps memory usage proportional to the largest
/// single paragraph, not the entire document.
///
/// FAILURE HANDLING: If the ZIP is corrupt or `word/document.xml` is missing,
/// the parser returns `ParseError::IoError` and the pipeline skips the file.
pub struct DocxParser;

/// Read the `w:val` attribute off a `<w:pStyle>` element.
fn style_value(e: &quick_xml::events::BytesStart) -> Option<String> {
    e.attributes().flatten().find_map(|attr| {
        if attr.key.local_name().as_ref() == b"val" {
            String::from_utf8(attr.value.into_owned()).ok()
        } else {
            None
        }
    })
}

/// Whether a DOCX paragraph style denotes a heading.
///
/// Word emits `Heading1`..`Heading9` for the built-in outline levels, and
/// localized builds sometimes use `heading 1` (with a space). `Title` and
/// `Subtitle` are treated as headings too since they carry document structure.
fn is_heading_style(style: Option<&str>) -> bool {
    let Some(style) = style else { return false };
    let normalized = style.replace([' ', '-', '_'], "").to_lowercase();
    normalized.starts_with("heading") || normalized == "title" || normalized == "subtitle"
}

impl Parser for DocxParser {
    fn supports(&self, ext: &str) -> bool {
        ext.eq_ignore_ascii_case("docx")
    }

    fn parse(&self, path: &str) -> Result<ParsedDocument, ParseError> {
        let file = std::fs::File::open(path)
            .map_err(|e| ParseError::IoError(format!("{}: {}", path, e)))?;

        // Handle empty files without crashing the ZIP parser
        if file.metadata().map(|m| m.len()).unwrap_or(0) == 0 {
            return Ok(ParsedDocument {
                file_path: path.to_string(),
                sections: vec![Section {
                    heading: None,
                    content: String::new(),
                    ..Default::default()
                }],
            });
        }

        // Pass raw File instead of BufReader to ZipArchive.
        // ZipArchive requires random access (Seek), and BufReader dumps its buffer
        // on every Seek, leading to poor performance and unnecessary allocations.
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|e| ParseError::IoError(format!("{}: not a valid ZIP/DOCX: {}", path, e)))?;

        let doc_xml = archive
            .by_name("word/document.xml")
            .map_err(|e| ParseError::IoError(
                format!("{}: word/document.xml not found: {}", path, e),
            ))?;

        let mut reader = quick_xml::Reader::from_reader(BufReader::new(doc_xml));
        reader.config_mut().trim_text(true);

        let mut sections: Vec<Section> = Vec::new();
        let mut current_paragraph = String::with_capacity(2048);
        let mut in_paragraph = false;
        let mut in_text = false;
        let mut buf = Vec::with_capacity(1024);

        // Heading tracking. A DOCX paragraph carries its style in
        // <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>. Previously this was
        // discarded and every paragraph became a heading-less section, so all
        // DOCX content collapsed into the catch-all "General" topic and notes
        // had no title. We now use styled paragraphs as section boundaries.
        let mut current_style: Option<String> = None;
        let mut current_heading: Option<String> = None;
        let mut current_body = String::with_capacity(4096);

        // Flush whatever has accumulated under the current heading.
        fn flush(
            sections: &mut Vec<Section>,
            heading: &mut Option<String>,
            body: &mut String,
        ) {
            let trimmed = body.trim().to_string();
            if !trimmed.is_empty() || heading.is_some() {
                sections.push(Section {
                    heading: heading.take(),
                    content: trimmed,
                    ..Default::default()
                });
            }
            body.clear();
        }

        // Streaming XML parse: we track <w:p> (paragraph), <w:pStyle> (style)
        // and <w:t> (text run) elements. Text from consecutive <w:t> elements
        // within a <w:p> is concatenated into a single paragraph string.
        loop {
            match reader.read_event_into(&mut buf) {
                // <w:pStyle> is self-closing, so it arrives as an Empty event.
                Ok(quick_xml::events::Event::Empty(ref e)) => {
                    if e.local_name().as_ref() == b"pStyle" && in_paragraph {
                        current_style = style_value(e);
                    }
                }
                Ok(quick_xml::events::Event::Start(ref e)) => {
                    let local_name = e.local_name();
                    if local_name.as_ref() == b"p" {
                        in_paragraph = true;
                        current_paragraph.clear();
                        current_style = None;
                    } else if local_name.as_ref() == b"pStyle" && in_paragraph {
                        current_style = style_value(e);
                    } else if local_name.as_ref() == b"t" && in_paragraph {
                        in_text = true;
                    }
                }
                Ok(quick_xml::events::Event::Text(ref e)) => {
                    if in_text {
                        if let Ok(text) = e.unescape() {
                            current_paragraph.push_str(&text);
                        }
                    }
                }
                Ok(quick_xml::events::Event::End(ref e)) => {
                    let local_name = e.local_name();
                    if local_name.as_ref() == b"t" {
                        in_text = false;
                    } else if local_name.as_ref() == b"p" {
                        in_paragraph = false;
                        let trimmed = current_paragraph.trim().to_string();

                        if !trimmed.is_empty() {
                            if is_heading_style(current_style.as_deref()) {
                                // Styled heading: close the previous section and
                                // start a new one titled with this paragraph.
                                flush(&mut sections, &mut current_heading, &mut current_body);
                                current_heading = Some(trimmed);
                            } else {
                                if !current_body.is_empty() {
                                    current_body.push_str("\n\n");
                                }
                                current_body.push_str(&trimmed);
                            }
                        }
                        current_style = None;
                    }
                }
                Ok(quick_xml::events::Event::Eof) => break,
                Err(e) => {
                    return Err(ParseError::IoError(
                        format!("{}: XML parse error: {}", path, e),
                    ));
                }
                _ => {}
            }
            buf.clear();
        }

        // Flush the trailing section.
        flush(&mut sections, &mut current_heading, &mut current_body);

        if sections.is_empty() {
            sections.push(Section {
                heading: None,
                content: String::new(),
                ..Default::default()
            });
        }

        Ok(ParsedDocument {
            file_path: path.to_string(),
            sections,
        })
    }
}

// ---------------------------------------------------------------------------
// Parser registry
// ---------------------------------------------------------------------------

/// Returns the appropriate parser for a given file path, or `None` if the
/// extension is not supported.
///
/// Phase 2 adds PDF and DOCX to the dispatch table. The dispatch order
/// does not matter since extensions are mutually exclusive.
pub fn parser_for_path(path: &str) -> Option<Box<dyn Parser>> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    let md = MarkdownParser;
    let txt = TxtParser;
    let pdf = PdfParser;
    let docx = DocxParser;

    if md.supports(ext) {
        Some(Box::new(MarkdownParser))
    } else if txt.supports(ext) {
        Some(Box::new(TxtParser))
    } else if pdf.supports(ext) {
        Some(Box::new(PdfParser))
    } else if docx.supports(ext) {
        Some(Box::new(DocxParser))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heading_styles_are_recognized() {
        assert!(is_heading_style(Some("Heading1")));
        assert!(is_heading_style(Some("Heading9")));
        // Localized / spaced variants Word also emits.
        assert!(is_heading_style(Some("heading 2")));
        assert!(is_heading_style(Some("Heading-3")));
        assert!(is_heading_style(Some("Title")));
        assert!(is_heading_style(Some("Subtitle")));
    }

    #[test]
    fn body_styles_are_not_headings() {
        assert!(!is_heading_style(None));
        assert!(!is_heading_style(Some("Normal")));
        assert!(!is_heading_style(Some("BodyText")));
        assert!(!is_heading_style(Some("ListParagraph")));
    }

    #[test]
    fn pdf_text_rejoins_layout_line_breaks() {
        // Hard wraps from the original page layout must not survive into the
        // index, or phrase search never matches across them.
        let raw = "the quick brown\nfox jumps over\nthe lazy dog";
        assert_eq!(
            normalize_pdf_text(raw),
            "the quick brown fox jumps over the lazy dog"
        );
    }

    #[test]
    fn pdf_text_rejoins_hyphenated_words() {
        // "knowl-\nedge" must become "knowledge", not "knowl- edge".
        let raw = "this is knowl-\nedge extrac-\ntion";
        assert_eq!(normalize_pdf_text(raw), "this is knowledge extraction");
    }

    #[test]
    fn pdf_text_drops_blank_lines_and_trims() {
        assert_eq!(normalize_pdf_text("  alpha  \n\n   \n beta "), "alpha beta");
        assert_eq!(normalize_pdf_text("   "), "");
    }

    #[test]
    fn markdown_parser_splits_on_headings() {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(file, "intro text\n\n# First\nalpha\n\n## Second\nbeta").unwrap();

        let path = file.path().to_string_lossy().to_string();
        let doc = MarkdownParser.parse(&path).unwrap();

        let headings: Vec<Option<String>> =
            doc.sections.iter().map(|s| s.heading.clone()).collect();
        assert_eq!(
            headings,
            vec![None, Some("First".to_string()), Some("Second".to_string())]
        );
    }
}
