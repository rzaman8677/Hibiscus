/**
 * ============================================================================
 * Markdown Lexer Unit Tests
 * ============================================================================
 * 
 * Tests for the scanMarkdownLine function from the inline decorator engine.
 * Verifies token extraction and boundary detection for all Markdown elements.
 * ============================================================================
 */

import { describe, it, expect } from 'vitest'
import { scanMarkdownLine, MarkdownToken } from '../src/components/Editor/markdownLineLexer'

// ---------------------------------------------------------------------------
// Helper to find first token of a given type
// ---------------------------------------------------------------------------
function findToken(tokens: MarkdownToken[], type: MarkdownToken['type']): MarkdownToken | undefined {
  return tokens.find(t => t.type === type)
}

function findAllTokens(tokens: MarkdownToken[], type: MarkdownToken['type']): MarkdownToken[] {
  return tokens.filter(t => t.type === type)
}

// ===========================================================================
// HEADINGS
// ===========================================================================
describe('Headings', () => {
  it('detects H1', () => {
    const tokens = scanMarkdownLine('# Hello World')
    const h = findToken(tokens, 'heading')
    expect(h).toBeDefined()
    expect(h!.level).toBe(1)
    expect(h!.startColumn).toBe(1)
    expect(h!.endColumn).toBe(14) // "# Hello World".length + 1
  })

  it('detects H2 through H6', () => {
    for (let level = 2; level <= 6; level++) {
      const prefix = '#'.repeat(level)
      const line = `${prefix} Title`
      const tokens = scanMarkdownLine(line)
      const h = findToken(tokens, 'heading')
      expect(h).toBeDefined()
      expect(h!.level).toBe(level)
    }
  })

  it('does not match # without space', () => {
    const tokens = scanMarkdownLine('#NoSpace')
    expect(findToken(tokens, 'heading')).toBeUndefined()
  })

  it('does not match 7 or more #', () => {
    const tokens = scanMarkdownLine('####### Not a heading')
    expect(findToken(tokens, 'heading')).toBeUndefined()
  })

  it('syntax range covers the # prefix plus space', () => {
    const tokens = scanMarkdownLine('## Heading Two')
    const h = findToken(tokens, 'heading')!
    expect(h.syntaxRanges).toHaveLength(1)
    // "## " is 3 chars, so syntax range is columns 1..4 (end exclusive)
    expect(h.syntaxRanges[0]).toEqual({ startColumn: 1, endColumn: 4 })
  })
})

// ===========================================================================
// BOLD
// ===========================================================================
describe('Bold', () => {
  it('detects **bold** text', () => {
    const tokens = scanMarkdownLine('This is **bold** text')
    const b = findToken(tokens, 'bold')
    expect(b).toBeDefined()
    // "**bold**" starts at index 8 -> column 9
    expect(b!.startColumn).toBe(9)
    expect(b!.endColumn).toBe(17) // 9 + 8
  })

  it('detects __bold__ text', () => {
    const tokens = scanMarkdownLine('This is __bold__ text')
    const b = findToken(tokens, 'bold')
    expect(b).toBeDefined()
  })

  it('syntax ranges mark the ** pairs', () => {
    const tokens = scanMarkdownLine('**bold**')
    const b = findToken(tokens, 'bold')!
    expect(b.syntaxRanges).toHaveLength(2)
    // Opening **
    expect(b.syntaxRanges[0]).toEqual({ startColumn: 1, endColumn: 3 })
    // Closing **
    expect(b.syntaxRanges[1]).toEqual({ startColumn: 7, endColumn: 9 })
  })

  it('detects multiple bold spans on one line', () => {
    const tokens = scanMarkdownLine('**first** and **second**')
    const bolds = findAllTokens(tokens, 'bold')
    expect(bolds).toHaveLength(2)
  })
})

// ===========================================================================
// ITALIC
// ===========================================================================
describe('Italic', () => {
  it('detects *italic* text', () => {
    const tokens = scanMarkdownLine('This is *italic* text')
    const i = findToken(tokens, 'italic')
    expect(i).toBeDefined()
  })

  it('detects _italic_ text', () => {
    const tokens = scanMarkdownLine('This is _italic_ text')
    const i = findToken(tokens, 'italic')
    expect(i).toBeDefined()
  })

  it('syntax ranges mark the * delimiters', () => {
    const tokens = scanMarkdownLine('*italic*')
    const i = findToken(tokens, 'italic')!
    expect(i.syntaxRanges).toHaveLength(2)
    expect(i.syntaxRanges[0]).toEqual({ startColumn: 1, endColumn: 2 })
    expect(i.syntaxRanges[1]).toEqual({ startColumn: 8, endColumn: 9 })
  })
})

// ===========================================================================
// STRIKETHROUGH
// ===========================================================================
describe('Strikethrough', () => {
  it('detects ~~strikethrough~~ text', () => {
    const tokens = scanMarkdownLine('This is ~~deleted~~ text')
    const s = findToken(tokens, 'strikethrough')
    expect(s).toBeDefined()
  })

  it('syntax ranges mark the ~~ pairs', () => {
    const tokens = scanMarkdownLine('~~deleted~~')
    const s = findToken(tokens, 'strikethrough')!
    expect(s.syntaxRanges).toHaveLength(2)
    expect(s.syntaxRanges[0]).toEqual({ startColumn: 1, endColumn: 3 })
    expect(s.syntaxRanges[1]).toEqual({ startColumn: 10, endColumn: 12 })
  })
})

// ===========================================================================
// INLINE CODE
// ===========================================================================
describe('Inline Code', () => {
  it('detects `code` spans', () => {
    const tokens = scanMarkdownLine('Use `const` here')
    const c = findToken(tokens, 'code')
    expect(c).toBeDefined()
  })

  it('syntax ranges mark the backtick delimiters', () => {
    const tokens = scanMarkdownLine('`code`')
    const c = findToken(tokens, 'code')!
    expect(c.syntaxRanges).toHaveLength(2)
    expect(c.syntaxRanges[0]).toEqual({ startColumn: 1, endColumn: 2 })
    expect(c.syntaxRanges[1]).toEqual({ startColumn: 6, endColumn: 7 })
  })

  it('detects multiple code spans on one line', () => {
    const tokens = scanMarkdownLine('Use `const` or `let`')
    const codes = findAllTokens(tokens, 'code')
    expect(codes).toHaveLength(2)
  })
})

// ===========================================================================
// BLOCKQUOTES
// ===========================================================================
describe('Blockquotes', () => {
  it('detects > blockquote', () => {
    const tokens = scanMarkdownLine('> This is a quote')
    const bq = findToken(tokens, 'blockquote')
    expect(bq).toBeDefined()
    expect(bq!.startColumn).toBe(1)
    expect(bq!.endColumn).toBe(18) // full line length + 1
  })

  it('syntax range covers "> "', () => {
    const tokens = scanMarkdownLine('> Quote text')
    const bq = findToken(tokens, 'blockquote')!
    expect(bq.syntaxRanges).toHaveLength(1)
    expect(bq.syntaxRanges[0]).toEqual({ startColumn: 1, endColumn: 3 })
  })

  it('does not match > without space', () => {
    const tokens = scanMarkdownLine('>NoSpace')
    expect(findToken(tokens, 'blockquote')).toBeUndefined()
  })
})

// ===========================================================================
// LISTS
// ===========================================================================
describe('Lists', () => {
  it('detects - list item', () => {
    const tokens = scanMarkdownLine('- Item one')
    const list = findToken(tokens, 'list')
    expect(list).toBeDefined()
  })

  it('detects * list item', () => {
    const tokens = scanMarkdownLine('* Item one')
    const list = findToken(tokens, 'list')
    expect(list).toBeDefined()
  })

  it('detects indented list items', () => {
    const tokens = scanMarkdownLine('  - Nested item')
    const list = findToken(tokens, 'list')
    expect(list).toBeDefined()
  })
})

// ===========================================================================
// TASK CHECKBOXES
// ===========================================================================
describe('Task Checkboxes', () => {
  it('detects unchecked task - [ ]', () => {
    const tokens = scanMarkdownLine('- [ ] Todo item')
    const task = findToken(tokens, 'task-unchecked')
    expect(task).toBeDefined()
  })

  it('detects checked task - [x]', () => {
    const tokens = scanMarkdownLine('- [x] Done item')
    const task = findToken(tokens, 'task-checked')
    expect(task).toBeDefined()
  })

  it('detects checked task - [X] (uppercase)', () => {
    const tokens = scanMarkdownLine('- [X] Done item')
    const task = findToken(tokens, 'task-checked')
    expect(task).toBeDefined()
  })

  it('task-checked endColumn covers the full line', () => {
    const line = '- [x] Done item'
    const tokens = scanMarkdownLine(line)
    const task = findToken(tokens, 'task-checked')!
    expect(task.endColumn).toBe(line.length + 1)
  })
})

// ===========================================================================
// LINKS
// ===========================================================================
describe('Links', () => {
  it('detects [text](url) link', () => {
    const tokens = scanMarkdownLine('Click [here](https://example.com) now')
    const link = findToken(tokens, 'link')
    expect(link).toBeDefined()
    expect(link!.url).toBe('https://example.com')
  })

  it('syntax ranges hide [ and ](url)', () => {
    const tokens = scanMarkdownLine('[text](url)')
    const link = findToken(tokens, 'link')!
    expect(link.syntaxRanges).toHaveLength(2)
    // Opening [
    expect(link.syntaxRanges[0]).toEqual({ startColumn: 1, endColumn: 2 })
    // ](url)
    expect(link.syntaxRanges[1]).toEqual({ startColumn: 6, endColumn: 12 })
  })

  it('detects multiple links on one line', () => {
    const tokens = scanMarkdownLine('[a](b) and [c](d)')
    const links = findAllTokens(tokens, 'link')
    expect(links).toHaveLength(2)
    expect(links[0].url).toBe('b')
    expect(links[1].url).toBe('d')
  })
})

// ===========================================================================
// WIKILINKS
// ===========================================================================
describe('WikiLinks', () => {
  it('detects [[Page]] wikilink', () => {
    const tokens = scanMarkdownLine('See [[My Page]] for details')
    const wl = findToken(tokens, 'wikilink')
    expect(wl).toBeDefined()
    expect(wl!.page).toBe('My Page')
  })

  it('syntax ranges mark the [[ and ]] brackets', () => {
    const tokens = scanMarkdownLine('[[Page]]')
    const wl = findToken(tokens, 'wikilink')!
    expect(wl.syntaxRanges).toHaveLength(2)
    expect(wl.syntaxRanges[0]).toEqual({ startColumn: 1, endColumn: 3 })
    expect(wl.syntaxRanges[1]).toEqual({ startColumn: 7, endColumn: 9 })
  })
})

// ===========================================================================
// HORIZONTAL RULES
// ===========================================================================
describe('Horizontal Rules', () => {
  it('detects --- as hr', () => {
    const tokens = scanMarkdownLine('---')
    const hr = findToken(tokens, 'hr')
    expect(hr).toBeDefined()
  })

  it('detects *** as hr', () => {
    const tokens = scanMarkdownLine('***')
    const hr = findToken(tokens, 'hr')
    expect(hr).toBeDefined()
  })

  it('detects ___ as hr', () => {
    const tokens = scanMarkdownLine('___')
    const hr = findToken(tokens, 'hr')
    expect(hr).toBeDefined()
  })

  it('detects hr with leading whitespace', () => {
    const tokens = scanMarkdownLine('  ---')
    const hr = findToken(tokens, 'hr')
    expect(hr).toBeDefined()
  })

  it('hr returns early (no other tokens)', () => {
    const tokens = scanMarkdownLine('---')
    // Should only contain the hr token (and potentially a heading if --- matched, but it shouldn't)
    expect(tokens.every(t => t.type === 'hr')).toBe(true)
  })
})

// ===========================================================================
// EDGE CASES
// ===========================================================================
describe('Edge Cases', () => {
  it('empty line returns no tokens', () => {
    const tokens = scanMarkdownLine('')
    expect(tokens).toHaveLength(0)
  })

  it('plain text returns no tokens', () => {
    const tokens = scanMarkdownLine('Just plain text with no markdown')
    expect(tokens).toHaveLength(0)
  })

  it('combined bold+italic on same line', () => {
    const tokens = scanMarkdownLine('**bold** and *italic*')
    expect(findToken(tokens, 'bold')).toBeDefined()
    expect(findToken(tokens, 'italic')).toBeDefined()
  })

  it('heading line with inline code', () => {
    const tokens = scanMarkdownLine('# Title with `code`')
    expect(findToken(tokens, 'heading')).toBeDefined()
    expect(findToken(tokens, 'code')).toBeDefined()
  })

  it('list item with bold text', () => {
    const tokens = scanMarkdownLine('- **Important** item')
    expect(findToken(tokens, 'list')).toBeDefined()
    expect(findToken(tokens, 'bold')).toBeDefined()
  })

  it('blockquote with link', () => {
    const tokens = scanMarkdownLine('> See [link](url) here')
    expect(findToken(tokens, 'blockquote')).toBeDefined()
    expect(findToken(tokens, 'link')).toBeDefined()
  })
})
