import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SearchPanel } from '../../../src/components/Search/SearchPanel';
import { mockInvoke } from '../../setup';

describe('SearchPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders status badge and toggles dashboard', async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === 'get_knowledge_status') {
        return Promise.resolve({
          state: 'Ready',
          indexed_files: 5,
          chunk_count: 15,
          schema_version: 2,
          last_indexed: 'now',
          last_rebuild: 'now',
          error_count: 0,
          skipped_count: 1,
          needs_rebuild: false
        });
      }
      if (command === 'get_topics') return Promise.resolve({});
      return Promise.resolve();
    });

    render(<SearchPanel open={true} onClose={vi.fn()} workspaceRoot="/mock/root" />);

    // Wait for the status badge to appear
    const badge = await screen.findByText('Ready / 1 skipped');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('state-ready');

    // Click badge to toggle dashboard
    fireEvent.click(badge);
    
    // Verify dashboard content
    const dashboardStats = await screen.findByText(/5.*files.*15.*chunks/i);
    expect(dashboardStats).toBeInTheDocument();
  });

  it('filters by topic', async () => {
    mockInvoke.mockImplementation((command, args) => {
      if (command === 'get_topics') {
        return Promise.resolve({
          'React': ['chunk1'],
          'Rust': ['chunk2']
        });
      }
      if (command === 'get_knowledge_status') return Promise.resolve({ state: 'Ready' });
      if (command === 'search_chunks') {
        if (args.topic === 'React') {
          return Promise.resolve([{
            chunk_id: 'c1',
            file: '/mock/root/react.md',
            content: 'React is a library',
            word_count: 4,
            score: 1.0
          }]);
        }
        return Promise.resolve([]);
      }
      return Promise.resolve();
    });

    render(<SearchPanel open={true} onClose={vi.fn()} workspaceRoot="/mock/root" />);

    // Select the topic
    const topicSelect = await screen.findByRole('combobox');
    fireEvent.change(topicSelect, { target: { value: 'React' } });

    // Perform search
    const searchInput = screen.getByPlaceholderText('Search your knowledge base...');
    fireEvent.change(searchInput, { target: { value: 'library' } });

    // Verify search was invoked with topic filter
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('search_chunks', expect.objectContaining({
        query: 'library',
        topic: 'React'
      }));
    });

    const result = await screen.findByText('React is a library');
    expect(result).toBeInTheDocument();
  });

  it('triggers onOpenFile with line navigation', async () => {
    const onOpenFileMock = vi.fn();
    mockInvoke.mockImplementation((command) => {
      if (command === 'get_knowledge_status') {
        return Promise.resolve({ state: 'Ready', skipped_count: 0 });
      }
      if (command === 'search_chunks') {
        return Promise.resolve([{
          chunk_id: 'c1',
          file: '/mock/root/doc.md',
          content: 'Hello world',
          word_count: 2,
          score: 1.0,
          start_line: 42
        }]);
      }
      if (command === 'get_topics') return Promise.resolve({});
      return Promise.resolve({});
    });

    render(<SearchPanel open={true} onClose={vi.fn()} workspaceRoot="/mock/root" onOpenFile={onOpenFileMock} />);

    const searchInput = screen.getByPlaceholderText('Search your knowledge base...');
    fireEvent.change(searchInput, { target: { value: 'Hello' } });

    // Wait for results
    const resultItem = await screen.findByText(/doc.md/);
    
    // Click result
    fireEvent.click(resultItem);

    expect(onOpenFileMock).toHaveBeenCalledWith('/mock/root/doc.md', 42);
  });
});
