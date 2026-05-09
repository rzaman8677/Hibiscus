import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RightPanelContainer } from '../../../src/components/RightPanel/RightPanelContainer';
import { StudyContext } from '../../../src/features/shared/StudyContext';
import { mockInvoke } from '../../setup';

describe('RightPanelContainer Knowledge Features', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderWithContext = (view: 'knowledge-graph' | 'backlinks', props: any = {}) => {
    return render(
      <StudyContext.Provider value={{
        rightPanelView: view,
        setRightPanelView: vi.fn(),
        isStudying: false,
        setIsStudying: vi.fn(),
        toggleStudySession: vi.fn()
      }}>
        <RightPanelContainer
          workspaceRoot="/mock/root"
          onOpenFile={vi.fn()}
          pomodoroState={{ isRunning: false, timeLeft: 0, mode: 'focus' }}
          pomodoroActions={{} as any}
          flashcards={{} as any}
          notes={{} as any}
          statsData={{
            totalStudyMinutes: 0,
            totalSessions: 0,
            currentStreak: 0,
            avgDailyMinutes: 0,
            weeklyData: [],
            recentSessions: []
          }}
          activeFilePath="/mock/root/target.md"
          {...props}
        />
      </StudyContext.Provider>
    );
  };

  it('renders backend knowledge graph data', async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === 'get_knowledge_graph') {
        return Promise.resolve({
          nodes: [{ id: '/mock/root/file1.md', label: 'File 1', tags: [], degree: 1 }],
          edges: []
        });
      }
      if (command === 'get_backlinks') return Promise.resolve({});
      return Promise.resolve();
    });

    // We mock the child component to easily verify props
    vi.mock('../../../src/features/knowledge/KnowledgeGraphView', () => ({
      KnowledgeGraphView: ({ graph }: any) => <div data-testid="graph-view">Nodes: {graph.nodes.length}</div>
    }));

    renderWithContext('knowledge-graph');

    await waitFor(() => {
      expect(screen.getByTestId('graph-view')).toHaveTextContent('Nodes: 1');
    });
  });

  it('renders backend backlinks data', async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === 'get_knowledge_graph') return Promise.resolve({ nodes: [], edges: [] });
      if (command === 'get_backlinks') {
        return Promise.resolve({
          '/mock/root/target.md': ['/mock/root/source1.md', '/mock/root/source2.md']
        });
      }
      return Promise.resolve();
    });

    renderWithContext('backlinks');

    await waitFor(() => {
      // The panel shows the count in the header
      expect(screen.getByText('2')).toBeInTheDocument();
      // The filenames should be visible
      expect(screen.getByText('source1.md')).toBeInTheDocument();
      expect(screen.getByText('source2.md')).toBeInTheDocument();
    });
  });
});
