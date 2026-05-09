# Metadata & Indexing Configurations

Hibiscus automatically extracts, tracks, and manages metadata from your workspace files to build a rich, connected knowledge base. This includes handling relationships, tags, and explicitly ignoring specific files.

## Automated Metadata Extraction

During the indexing pipeline, Hibiscus parses your Markdown files to build a persistent, localized metadata store. This metadata feeds directly into the graph visualization and search systems.

### Tags

Hibiscus automatically detects and indexes `#tags` within your content. Tags must use alphanumeric characters, hyphens, or underscores. These are aggregated to support tag-based filtering in the search and graph interfaces.

### Wiki-Links

Bidirectional relationships are established via `[[wiki-link]]` syntax. The indexer captures these links and resolves them against file paths to build the underlying knowledge graph.

### Aliases (Frontmatter)

If your Markdown files utilize YAML frontmatter, the indexer parses the `aliases` array.

```yaml
---
aliases: [AI, Machine Learning]
---
```

These aliases are extracted and associated with the file's chunk data, ensuring search queries match the document even if the primary filename is different.

### Backlinks

As wiki-links are processed, the system automatically builds a persistent `backlinks.json` mapping. This allows the Right Panel UI to display a list of all documents that reference the currently active file in O(1) time.

## Workspace Exclusions (`.hibiscusignore`)

You can prevent Hibiscus from indexing specific files or directories by creating a `.hibiscusignore` file in the root of your workspace.

### Behavior

- The `.hibiscusignore` file follows simple substring matching logic.
- Adding a directory name (e.g., `node_modules/` or `secrets/`) will prevent the indexer from scanning any files within those paths.
- Adding a specific filename (e.g., `private_notes.md`) will exclude that exact file.
- Ignored files are tracked and reported in the Knowledge Dashboard under the "Skipped" count.

Note: The `.hibiscus` internal state directory is always ignored by default to prevent recursive indexing loops.

## Large File Management

To preserve memory efficiency and prevent UI stuttering, the background worker enforces a strict large file threshold.

- **Threshold**: Any file exceeding 10MB is automatically bypassed.
- **Reporting**: Bypassed files are logged to `skipped_files.json` and visibly reported in the Knowledge Dashboard.
- **Handling**: These files will not appear in search results, nor will their contents be processed for wiki-links or tags.
