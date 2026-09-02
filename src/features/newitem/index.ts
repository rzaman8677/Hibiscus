// ============================================================================
// New Item Feature -- Public API
// ============================================================================

export { useNewItemController } from "./useNewItemController"
export { useNewItemModal } from "./useNewItemModal"
export { createItemCommand } from "./createItemCommand"
export { parseInput, validatePath } from "./inputEngine"
export { generateSuggestions, invalidateSuggestionCache } from "./suggestionEngine"

export type {
  NewItemState,
  ParsedPath,
  Suggestion,
  ValidationResult,
  CreateItemRequest,
  NewItemMode,
} from "./types"
export { flattenTree } from "./types"
