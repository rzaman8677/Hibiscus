import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RightPanelContainer } from '../../../src/components/RightPanel/RightPanelContainer';
import { StudyContext } from '../../../src/features/shared/StudyContext';
import { mockInvoke } from '../../setup';

describe('RightPanelContainer Knowledge Features', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Container mounts useCalendarController, which invokes read_calendar_data.
    // Provide a benign default so unrelated invokes resolve instead of returning undefined.
    mockInvoke.mockResolvedValue({});
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

  // We mock the child component to easily verify props.
  // (Hoisted by Vitest above imports, so it applies to the whole file.)
  vi.mock('../../../src/features/knowledge/KnowledgeGraphView', () => ({
    KnowledgeGraphView: ({ graph }: any) => <div data-testid="graph-view">Nodes: {graph.nodes.length}</div>
  }));

  it('renders the knowledge graph it is given via props', async () => {
    // Data now flows in as props (fetched once in App via useBackendKnowledge),
    // rather than being fetched inside the container.
    renderWithContext('knowledge-graph', {
      knowledgeGraph: {
        nodes: [{ id: '/mock/root/file1.md', label: 'File 1', tags: [], degree: 1 }],
        edges: []
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId('graph-view')).toHaveTextContent('Nodes: 1');
    });
  });

  it('renders backlinks from the backend backlink map prop', async () => {
    renderWithContext('backlinks', {
      knowledgeBacklinks: {
        '/mock/root/target.md': ['/mock/root/source1.md', '/mock/root/source2.md']
      }
    });

    await waitFor(() => {
      // The panel shows the count in the header
      expect(screen.getByText('2')).toBeInTheDocument();
      // The filenames should be visible without extensions
      expect(screen.getByText('source1')).toBeInTheDocument();
      expect(screen.getByText('source2')).toBeInTheDocument();
    });
  });
});
