import { useCallback, useState } from "react"

export type MarkdownViewMode = "live-preview" | "source"

interface MarkdownViewModeState {
  activeMode: MarkdownViewMode
  toggleActiveMode: () => void
}

function isMarkdownFile(path: string | null): path is string {
  return path?.toLowerCase().endsWith(".md") === true
}

export function useMarkdownViewMode(activeFilePath: string | null): MarkdownViewModeState {
  const [viewModes, setViewModes] = useState<Record<string, MarkdownViewMode>>({})

  const activeMode: MarkdownViewMode = isMarkdownFile(activeFilePath)
    ? (viewModes[activeFilePath] ?? "live-preview")
    : "source"

  const toggleActiveMode = useCallback(() => {
    if (!isMarkdownFile(activeFilePath)) return

    setViewModes((current) => ({
      ...current,
      [activeFilePath]: (current[activeFilePath] ?? "live-preview") === "live-preview"
        ? "source"
        : "live-preview",
    }))
  }, [activeFilePath])

  return { activeMode, toggleActiveMode }
}
