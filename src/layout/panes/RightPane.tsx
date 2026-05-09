import { RightPanelContainer } from "../../components/RightPanel/RightPanelContainer"

export interface RightPaneProps {
  workspaceRoot: string | null
  onOpenFile: (filePath: string, line?: number) => void
  pomodoroState: any
  pomodoroActions: any
  flashcards: any
  notes: any
  statsData: any
  knowledgeGraph: any
  knowledgeIndex: any
  activeFilePath: string | null
}

export function RightPane(props: RightPaneProps) {
  return (
    <RightPanelContainer
      workspaceRoot={props.workspaceRoot}
      onOpenFile={props.onOpenFile}
      pomodoroState={props.pomodoroState}
      pomodoroActions={props.pomodoroActions}
      flashcards={props.flashcards}
      notes={props.notes}
      statsData={props.statsData}
      knowledgeGraph={props.knowledgeGraph}
      knowledgeIndex={props.knowledgeIndex}
      activeFilePath={props.activeFilePath}
    />
  )
}
