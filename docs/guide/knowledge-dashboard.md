# Knowledge Dashboard & Status Management

The Knowledge Dashboard provides complete visibility and control over your Hibiscus indexing system. It allows you to monitor the health of your knowledge base, track errors, and manually intervene if the index requires repair.

## Status Badge

The status badge is located in the header of the Search Panel. It provides an immediate, at-a-glance view of the indexing system's current state.

### States

- **Ready**: The index is fully synchronized with your workspace. All supported files have been parsed and chunked.
- **Indexing**: The background worker is actively processing files. This occurs during the initial scan or when bulk modifications are detected.
- **Needs Rebuild**: The system has detected an inconsistency, a schema version mismatch, or corruption. The index must be manually rebuilt.
- **Skipped / Errors**: The badge will append notices (e.g., "Ready / 1 skipped") if files were ignored due to size constraints or parsing failures.

## The Dashboard Panel

Clicking the status badge expands the Knowledge Dashboard, revealing detailed metrics about your knowledge base infrastructure.

### Metrics Displayed

- **Total Files**: The number of valid files (`.md`, `.txt`, `.pdf`, `.docx`) successfully indexed.
- **Total Chunks**: The total number of chunks generated across all files.
- **Schema Version**: The current internal database schema version (e.g., v2).
- **Error Count**: The number of files that failed to parse correctly.
- **Skipped Count**: The number of files bypassed (e.g., files exceeding the 10MB limit or matching `.hibiscusignore` patterns).

## Repair UX

If your knowledge base falls out of sync or encounters errors, the dashboard provides direct repair controls.

### Rebuild

The **Rebuild** action forces a complete re-scan of your workspace. It clears the current memory cache and re-hashes all files. Use this if search results appear stale or if the status badge indicates "Needs Rebuild".

### Clear

The **Clear** action entirely wipes the `.hibiscus/knowledge` storage directory. This destroys the index, cached chunks, and metadata tracking. Use this as a last resort for unrecoverable corruption. Once cleared, the system will automatically initiate a fresh background scan.

## Error Handling

When files fail to index, they do not halt the worker pipeline. Instead, they are flagged and tracked. The dashboard aggregates these failures, allowing the rest of your workspace to remain searchable. Large files (defaulting to >10MB) are intentionally skipped to preserve memory efficiency and are similarly reported in the dashboard.
