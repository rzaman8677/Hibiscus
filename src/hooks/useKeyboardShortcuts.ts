import { useEffect, useRef } from "react";

export interface ShortcutHandlers {
    onSave?: () => void;
    onSaveAll?: () => void;
    onOpenFolder?: () => void;
    onToggleLeftPanel?: () => void;
    onToggleRightPanel?: () => void;
    onToggleShortcutOverlay?: () => void;
    onOpenPomodoro?: () => void;
    onToggleFocusMode?: () => void;
    onOpenSettings?: () => void;
    onOpenSearch?: () => void;
    onToggleMarkdownPreview?: () => void;
    onToggleGraphView?: () => void;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
    const handlersRef = useRef(handlers);
    handlersRef.current = handlers;

    useEffect(() => {
        let focusModeChordActive = false;
        
        const handleKeyDown = (e: KeyboardEvent) => {
            const isCtrl = e.ctrlKey || e.metaKey;

            // Note: Ctrl+S and Ctrl+Shift+S are already handled in useEditorController
            // but we can add them here if we want a global fallback or let editor handle them.
            // For now, let's keep Editor shortcuts in useEditorController for active file specificity.

            if (isCtrl && !e.shiftKey && e.key.toLowerCase() === 'o') {
                e.preventDefault();
                handlersRef.current.onOpenFolder?.();
            }

            if (isCtrl && !e.shiftKey && e.key.toLowerCase() === 'b') {
                e.preventDefault();
                handlersRef.current.onToggleLeftPanel?.();
            }

            if (isCtrl && !e.shiftKey && e.key.toLowerCase() === 'j') {
                e.preventDefault();
                handlersRef.current.onToggleRightPanel?.();
            }

            if (isCtrl && (e.key === '?' || e.key === '/')) {
                e.preventDefault();
                handlersRef.current.onToggleShortcutOverlay?.();
            }

            // Ctrl+Alt+P -> Pomodoro
            if (isCtrl && e.altKey && e.key.toLowerCase() === 'p') {
                e.preventDefault();
                handlersRef.current.onOpenPomodoro?.();
            }

            // Ctrl+F -> Start focus mode chord
            if (isCtrl && !e.shiftKey && e.key.toLowerCase() === 'f') {
                e.preventDefault();
                focusModeChordActive = true;
                return;
            }

            // M key after Ctrl+F -> Focus Mode
            if (focusModeChordActive && e.key.toLowerCase() === 'm') {
                e.preventDefault();
                focusModeChordActive = false;
                handlersRef.current.onToggleFocusMode?.();
                return;
            }

            // Any other key after Ctrl+F -> Cancel chord
            if (focusModeChordActive) {
                focusModeChordActive = false;
            }

            // Ctrl+Shift+F -> Open Search
            if (isCtrl && e.shiftKey && e.key.toLowerCase() === 'f') {
                e.preventDefault();
                handlersRef.current.onOpenSearch?.();
            }

            // Ctrl+, -> Settings
            if (isCtrl && !e.shiftKey && e.key === ',') {
                e.preventDefault();
                handlersRef.current.onOpenSettings?.();
            }

            // Ctrl+M -> Toggle Markdown Preview
            if (isCtrl && !e.shiftKey && e.key.toLowerCase() === 'm') {
                e.preventDefault();
                handlersRef.current.onToggleMarkdownPreview?.();
            }

            // Ctrl+G -> Toggle Knowledge Graph view
            if (isCtrl && !e.shiftKey && e.key.toLowerCase() === 'g') {
                e.preventDefault();
                handlersRef.current.onToggleGraphView?.();
            }
        };

        // Use capture phase (true) so global shortcuts fire BEFORE Monaco
        // or other child components can swallow them and stop propagation.
        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, []);
}
