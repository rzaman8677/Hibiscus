/**
 * ============================================================================
 * Markdown Line Lexer
 * ============================================================================
 *
 * Lightweight, dependency-free line-by-line Markdown scanner.
 * 
 * Returns an array of MarkdownToken objects describing the Markdown
 * elements found on a single line. Columns are 1-indexed to match
 * Monaco editor conventions.
 *
 * This module has ZERO external dependencies — it does not import
 * Monaco or any other library — so it can be unit-tested in any
 * JavaScript runtime without DOM or editor mocks.
 * ============================================================================
 */

/**
 * Describes a single Markdown element found on a line.
 * Columns are 1-indexed (Monaco convention).
 */
export interface MarkdownToken {
  type: 'heading' | 'bold' | 'italic' | 'strikethrough' | 'code' | 'blockquote' | 'list' | 'task-unchecked' | 'task-checked' | 'link' | 'wikilink' | 'hr';
  startColumn: number;
  endColumn: number;
  /** Ranges of syntax characters to hide on inactive lines */
  syntaxRanges: Array<{ startColumn: number; endColumn: number }>;
  /** Heading level (1-6), only present for heading tokens */
  level?: number;
  /** Link URL, only present for link tokens */
  url?: string;
  /** WikiLink page name, only present for wikilink tokens */
  page?: string;
}

/**
 * Scan a single line of Markdown text and return an array of tokens
 * representing the Markdown elements found on that line.
 *
 * This function is pure and stateless — it knows nothing about code
 * fences, frontmatter, or cursor position. Those concerns are handled
 * by the decorator engine that calls this function.
 *
 * @param line - A single line of Markdown text (no newline characters)
 * @returns Array of MarkdownToken objects found on the line
 */
export function scanMarkdownLine(line: string): MarkdownToken[] {
  const tokens: MarkdownToken[] = [];

  // -------------------------------------------------------------------------
  // Headings: # through ######
  // -------------------------------------------------------------------------
  const headingMatch = line.match(/^(#{1,6})\s/);
  if (headingMatch) {
    tokens.push({
      type: 'heading',
      level: headingMatch[1].length,
      startColumn: 1,
      endColumn: line.length + 1,
      syntaxRanges: [{ startColumn: 1, endColumn: headingMatch[0].length + 1 }]
    });
  }

  // -------------------------------------------------------------------------
  // Horizontal Rules: ---, ***, ___
  // If the line is an HR, return immediately — no inline parsing needed.
  // -------------------------------------------------------------------------
  if (/^\s*[-*_]{3,}\s*$/.test(line)) {
    tokens.push({
      type: 'hr',
      startColumn: 1,
      endColumn: line.length + 1,
      syntaxRanges: []
    });
    return tokens;
  }

  // -------------------------------------------------------------------------
  // Blockquotes: > text
  // -------------------------------------------------------------------------
  const bqMatch = line.match(/^>\s/);
  if (bqMatch) {
    tokens.push({
      type: 'blockquote',
      startColumn: 1,
      endColumn: line.length + 1,
      syntaxRanges: [{ startColumn: 1, endColumn: bqMatch[0].length + 1 }]
    });
  }

  // -------------------------------------------------------------------------
  // Lists & Tasks: -, *, +, 1., - [ ], - [x]
  // -------------------------------------------------------------------------
  const listMatch = line.match(/^(\s*[-*+]\s+)(\[(?: |x|X)\]\s+)?/);
  if (listMatch) {
    const syntaxEnd = listMatch[0].length + 1;
    const isTask = !!listMatch[2];
    const isChecked = isTask && /\[[xX]\]/.test(listMatch[2]);

    tokens.push({
      type: isTask ? (isChecked ? 'task-checked' : 'task-unchecked') : 'list',
      startColumn: 1,
      endColumn: isTask ? line.length + 1 : listMatch[1].length + 1,
      syntaxRanges: isTask ? [] : [{ startColumn: 1, endColumn: syntaxEnd }]
    });
  }

  // -------------------------------------------------------------------------
  // Inline element scanner helper
  // -------------------------------------------------------------------------
  const scanInline = (regex: RegExp, type: MarkdownToken['type'], hasSyntax: boolean = true) => {
    let match;
    while ((match = regex.exec(line)) !== null) {
      const start = match.index + 1;
      const end = start + match[0].length;

      let syntaxRanges: { startColumn: number; endColumn: number }[] = [];
      if (hasSyntax) {
        if (type === 'bold') {
          syntaxRanges = [
            { startColumn: start, endColumn: start + 2 },
            { startColumn: end - 2, endColumn: end }
          ];
        } else if (type === 'italic' || type === 'code' || type === 'strikethrough') {
          const symLen = type === 'strikethrough' ? 2 : 1;
          syntaxRanges = [
            { startColumn: start, endColumn: start + symLen },
            { startColumn: end - symLen, endColumn: end }
          ];
        } else if (type === 'link') {
          // [text](url) -> hide `[` and `](url)`
          const textStart = start + 1;
          const textEnd = start + 1 + match[1].length;
          syntaxRanges = [
            { startColumn: start, endColumn: textStart },
            { startColumn: textEnd, endColumn: end }
          ];
        } else if (type === 'wikilink') {
          // [[page]] -> hide `[[` and `]]`
          syntaxRanges = [
            { startColumn: start, endColumn: start + 2 },
            { startColumn: end - 2, endColumn: end }
          ];
        }
      }

      const token: MarkdownToken = { type, startColumn: start, endColumn: end, syntaxRanges };
      if (type === 'link') token.url = match[2];
      if (type === 'wikilink') token.page = match[1];

      tokens.push(token);
    }
  };

  // Bold: **text** and __text__
  scanInline(/\*\*([^*]+)\*\*/g, 'bold');
  scanInline(/__([^_]+)__/g, 'bold');

  // Italic: *text* and _text_ (negative lookbehind/ahead to avoid matching **)
  scanInline(/(?<!\*)\*([^*]+)\*(?!\*)/g, 'italic');
  scanInline(/(?<!_)_([^_]+)_(?!_)/g, 'italic');

  // Strikethrough: ~~text~~
  scanInline(/~~([^~]+)~~/g, 'strikethrough');

  // Inline code: `code`
  scanInline(/`([^`]+)`/g, 'code');

  // Links: [text](url)
  scanInline(/\[([^\]]+)\]\(([^)]+)\)/g, 'link');

  // WikiLinks: [[page]]
  scanInline(/\[\[([^\]]+)\]\]/g, 'wikilink');

  return tokens;
}
