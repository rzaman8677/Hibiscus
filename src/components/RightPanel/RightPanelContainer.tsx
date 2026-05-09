/**
 * ============================================================================
 * RightPanelContainer Component
 * ============================================================================
 *
 * Smart container that integrates the right panel with two view modes:
 *
 * 1. CALENDAR VIEW (default): Calendar + Daily Planner (original behavior)
 * 2. STUDY TOOLS VIEW: Pomodoro, Flashcards, Notes, or Stats
 *
 * The view is controlled by StudyContext.rightPanelView, and the user
 * can toggle between Calendar and Study Tools via a tab bar at the top.
 *
 * ARCHITECTURE:
 * - Composition layer that keeps App.tsx clean
 * - Receives hook instances as props (Pomodoro, Flashcards, etc.)
 * - Routes to the correct view based on context state
 * ============================================================================
 */

import { useState, useMemo, useEffect } from "react"
import { invoke } from "@tauri-apps/api/core"
import { RightPanel } from "./RightPanel"
import { CalendarView } from "./CalendarView"
import { DailyPlanner } from "./PlannerSection/DailyPlanner"
import { TaskList } from "./PlannerSection/TaskList"
import { EventModal } from "./EventModal"
import { useCalendarController } from "../../hooks/useCalendarController"
import { CalendarEvent, formatLocalDate } from "../../types/calendar"
import { useStudy, type RightPanelView } from "../../features/shared/StudyContext"
import { PomodoroPanel } from "../../features/pomodoro/PomodoroPanel"
import { FlashcardPanel } from "../../features/flashcards/FlashcardPanel"
import { NotesSynthesizer } from "../../features/notes/NotesSynthesizer"
import { StatsPanel } from "../../features/stats/StatsPanel"
import { StudyPanel } from "../../features/study/StudyPanel"
import { SearchPanel } from "../../components/Search/SearchPanel"
import type { PomodoroState, PomodoroActions } from "../../features/pomodoro/usePomodoro"
import type { useFlashcards } from "../../features/flashcards/useFlashcards"
import type { useNotesSynthesis } from "../../features/notes/useNotesSynthesis"
import type { DailyAggregate, StudySession } from "../../features/stats/statsTypes"
import { KnowledgeGraphView } from "../../features/knowledge/KnowledgeGraphView"
import { BacklinksPanel } from "../../features/knowledge/BacklinksPanel"
import type { GraphData } from "../../features/knowledge/buildGraph"
import type { KnowledgeIndex } from "../../features/knowledge/useKnowledgeIndex"
import "./PlannerSection/Planner.css"

interface RightPanelContainerProps {
    workspaceRoot: string | null
    onOpenFile: (path: string, line?: number) => void
    /** Pomodoro state + actions from the hook */
    pomodoroState: PomodoroState
    pomodoroActions: PomodoroActions
    /** Flashcards hook instance */
    flashcards: ReturnType<typeof useFlashcards>
    /** Notes hook instance */
    notes: ReturnType<typeof useNotesSynthesis>
    /** Stats data */
    statsData: {
        totalStudyMinutes: number
        totalSessions: number
        currentStreak: number
        avgDailyMinutes: number
        weeklyData: DailyAggregate[]
        recentSessions: StudySession[]
    }
    /** Knowledge graph data (memoized by caller) */
    knowledgeGraph?: GraphData
    /** Knowledge index for backlinks */
    knowledgeIndex?: KnowledgeIndex
    /** Currently active file path (for backlinks panel) */
    activeFilePath?: string | null
}

/**
 * Tab definitions for the right panel view switcher.
 */
const VIEW_TABS: { id: RightPanelView; label: string }[] = [
    { id: "calendar", label: "Calendar" },
    { id: "search", label: "Search" },
    { id: "knowledge-graph", label: "Graph" },
    { id: "backlinks", label: "Backlinks" },
    { id: "pomodoro", label: "Pomodoro" },
    { id: "study", label: "Study" },
    { id: "stats", label: "Stats" },
]

export function RightPanelContainer({
    workspaceRoot,
    onOpenFile,
    pomodoroState,
    pomodoroActions,
    flashcards,
    notes,
    statsData,
    knowledgeGraph,
    knowledgeIndex,
    activeFilePath,
}: RightPanelContainerProps) {
    const { events, tasks, toggleTask, addEvent, updateEvent, deleteEvent } = useCalendarController(workspaceRoot)
    const { rightPanelView, setRightPanelView } = useStudy()
    const [backendGraph, setBackendGraph] = useState<GraphData | null>(null)
    const [backendBacklinks, setBackendBacklinks] = useState<Record<string, string[]> | null>(null)

    useEffect(() => {
        if (!workspaceRoot) return
        let cancelled = false
        async function loadBackendKnowledge() {
            try {
                const [graph, backlinks] = await Promise.all([
                    invoke<GraphData>("get_knowledge_graph"),
                    invoke<Record<string, string[]>>("get_backlinks"),
                ])
                if (!cancelled) {
                    if (graph.nodes?.length) setBackendGraph(graph)
                    setBackendBacklinks(backlinks)
                }
            } catch (error) {
                console.warn("[Knowledge] Backend graph unavailable, using frontend fallback", error)
            }
        }
        loadBackendKnowledge()
        const interval = window.setInterval(loadBackendKnowledge, 5000)
        return () => {
            cancelled = true
            window.clearInterval(interval)
        }
    }, [workspaceRoot])

    // UI State for calendar
    const [modalOpen, setModalOpen] = useState(false)
    const [selectedDateValue, setSelectedDateValue] = useState<Date>(new Date())
    const [editingEvent, setEditingEvent] = useState<CalendarEvent | undefined>(undefined)

    // Derived state: Today's date string
    const todayStr = formatLocalDate(new Date())

    // Filter events for today
    const todayEvents = useMemo(() =>
        events.filter(e => e.date === todayStr)
        , [events, todayStr])

    // Filter tasks: separate today from upcoming
    const { dailyTasks, upcomingTasks } = useMemo(() => {
        const daily: typeof tasks = []
        const upcoming: typeof tasks = []

        tasks.forEach(t => {
            if (t.date === todayStr || !t.date) daily.push(t)
            else upcoming.push(t)
        })

        return { dailyTasks: daily, upcomingTasks: upcoming }
    }, [tasks, todayStr])

    // Calendar Handlers
    const handleDateSelect = (date: Date) => {
        setSelectedDateValue(date)
    }

    const handleAddEvent = (date: Date) => {
        setSelectedDateValue(date)
        setEditingEvent(undefined)
        setModalOpen(true)
    }

    const handleEventClick = (event: CalendarEvent) => {
        setEditingEvent(event)
        setModalOpen(true)
    }

    const handleSaveEvent = (eventData: Partial<CalendarEvent>) => {
        if (editingEvent) {
            updateEvent({ ...editingEvent, ...eventData } as CalendarEvent)
        } else {
            addEvent(eventData)
        }
        setModalOpen(false)
    }

    // =========================================================================
    // RENDER STUDY TOOL CONTENT
    // =========================================================================

    function renderStudyTool() {
        switch (rightPanelView) {
            case "search":
                return (
                    <SearchPanel
                        open={true}
                        onClose={() => {}}
                        workspaceRoot={workspaceRoot}
                        onOpenFile={onOpenFile}
                    />
                )
            case "knowledge-graph":
                return (backendGraph || knowledgeGraph) ? (
                    <KnowledgeGraphView
                        graph={backendGraph || knowledgeGraph!}
                        activeFilePath={activeFilePath ?? null}
                        onNodeClick={onOpenFile}
                        onBack={() => {}}
                    />
                ) : null
            case "backlinks":
                if (backendBacklinks && activeFilePath) {
                    const links = Array.from(new Set(backendBacklinks[activeFilePath] || []))
                    return (
                        <div className="backlinks-panel">
                            <div className="backlinks-header">
                                <span className="backlinks-title">Backlinks</span>
                                <span className="backlinks-count">{links.length}</span>
                            </div>
                            {links.length === 0 ? (
                                <div className="backlinks-empty">No notes link to this file</div>
                            ) : (
                                <ul className="backlinks-list">
                                    {links.map((sourcePath) => (
                                        <li key={sourcePath} className="backlinks-item">
                                            <button className="backlinks-link" onClick={() => onOpenFile(sourcePath)} title={sourcePath}>
                                                <span>{sourcePath.split(/[\\/]/).pop()?.replace(/\.(md|txt|markdown)$/i, "") || sourcePath}</span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )
                }
                return knowledgeIndex ? (
                    <BacklinksPanel
                        currentPath={activeFilePath ?? null}
                        index={knowledgeIndex}
                        onOpenFile={onOpenFile}
                    />
                ) : null
            case "pomodoro":
                return (
                    <PomodoroPanel
                        state={pomodoroState}
                        actions={pomodoroActions}
                    />
                )
            case "study":
                return <StudyPanel flashcards={flashcards} notes={notes} />
            case "flashcards":
                return <FlashcardPanel flashcards={flashcards} />
            case "notes":
                return <NotesSynthesizer notes={notes} />
            case "stats":
                return (
                    <StatsPanel
                        totalStudyMinutes={statsData.totalStudyMinutes}
                        totalSessions={statsData.totalSessions}
                        currentStreak={statsData.currentStreak}
                        avgDailyMinutes={statsData.avgDailyMinutes}
                        weeklyData={statsData.weeklyData}
                        recentSessions={statsData.recentSessions}
                    />
                )
            default:
                return null
        }
    }

    // =========================================================================
    // RENDER
    // =========================================================================

    return (
        <>
            {/* View switcher tab bar */}
            <div className="right-panel-tabs">
                {VIEW_TABS.map((tab) => (
                    <button
                        key={tab.id}
                        className={`right-panel-tab ${rightPanelView === tab.id ? "active" : ""}`}
                        onClick={() => setRightPanelView(tab.id)}
                        title={tab.label}
                    >
                        <span className="right-panel-tab-label">{tab.label}</span>
                    </button>
                ))}
            </div>

            {/* Content based on current view */}
            {rightPanelView === "calendar" ? (
                /* Calendar view (original layout) */
                <RightPanel
                    onOpenFile={onOpenFile}
                    calendarContent={
                        <CalendarView
                            events={events}
                            selectedDate={selectedDateValue}
                            onDateSelect={handleDateSelect}
                            onAddEvent={handleAddEvent}
                            onEventClick={handleEventClick}
                        />
                    }
                    plannerContent={
                        <>
                            <DailyPlanner
                                tasks={dailyTasks}
                                todayEvents={todayEvents}
                                onToggleTask={toggleTask}
                                onOpenFile={onOpenFile}
                            />
                            <TaskList
                                tasks={upcomingTasks}
                                onToggleTask={toggleTask}
                            />
                        </>
                    }
                />
            ) : (
                /* Study tool view */
                <div className="right-panel-study-content">
                    {renderStudyTool()}
                </div>
            )}

            <EventModal
                isOpen={modalOpen}
                onClose={() => setModalOpen(false)}
                onSave={handleSaveEvent}
                initialDate={selectedDateValue}
                eventToEdit={editingEvent}
                onDelete={deleteEvent}
            />
        </>
    )
}
