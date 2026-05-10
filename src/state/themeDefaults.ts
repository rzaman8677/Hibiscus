/**
 * ============================================================================
 * Theme Defaults — Preset Theme Definitions
 * ============================================================================
 *
 * Contains the built-in (preset) themes as static JSON objects.
 * These are READ-ONLY — users must duplicate a preset to edit it.
 *
 * ARCHITECTURE:
 * - This module is the single source of truth for preset theme token values
 * - themeRegistry.ts imports these to build the theme list
 * - ThemeContext.tsx uses REQUIRED_TOKENS for validation
 * - Theme names here MUST match the [data-theme="..."] values in theme.css
 *
 * ADDING A NEW TOKEN:
 * 1. Add to ALL_TOKENS array
 * 2. Add default value to each preset theme object
 * 3. If it's mandatory, add to REQUIRED_TOKENS
 * 4. Add matching CSS variable to theme.css
 * ============================================================================
 */

import type { Theme } from "./themeRegistry"
import midnightJson from "../styles/midnight.json"
import dawnJson from "../styles/dawn.json"
import forestJson from "../styles/forest.json"
import petalsJson from "../styles/petals.json"

// =============================================================================
// TOKEN DEFINITIONS
// =============================================================================

/**
 * Tokens that MUST be present in every theme for the app to render correctly.
 * If any of these are missing, validation will fail and fallback is triggered.
 */
export const REQUIRED_TOKENS = [
  "--bg",
  "--text",
  "--editor-bg",
  "--editor-fg",
] as const

/**
 * All supported theme tokens. Themes may omit non-required tokens;
 * they will be filled in from the default (midnight) theme via merging.
 */
export const ALL_TOKENS = [
  // Backgrounds
  "--bg",
  "--bg-elevated",
  "--panel-bg",
  "--panel-bg-hover",
  "--editor-bg",

  // Borders
  "--border",
  "--border-hover",
  "--border-focus",
  "--divider",

  // Text
  "--text",
  "--text-muted",
  "--text-subtle",
  "--text-disabled",

  // Accent
  "--accent",
  "--accent-hover",
  "--accent-soft",
  "--accent-glow",
  "--accent-secondary",
  "--accent-secondary-soft",

  // Semantic colors
  "--success",
  "--success-soft",
  "--warning",
  "--warning-soft",
  "--error",
  "--error-soft",
  "--info",
  "--info-soft",

  // Editor-specific
  "--editor-fg",
  "--editor-muted",
  "--editor-keyword",
  "--editor-string",
  "--editor-comment",
  "--editor-selection",
  "--editor-line-highlight",
  "--editor-highlight",
  "--editor-cursor",

  // Selection colors
  "--selection-bg",
  "--selection-text",

  // Light/Darkmode override switch
  "--theme-mode ",
] as const

// =============================================================================
// PRESET THEME DEFINITIONS
// =============================================================================

/**
 * Midnight — Default dark theme (Tokyo Night inspired)
 * This theme's tokens are also used as the fallback/default for merging.
 */
export const MIDNIGHT_THEME: Theme = midnightJson as Theme

/**
 * Dawn — Light theme (clean, paper-like aesthetics)
 */
export const DAWN_THEME: Theme = dawnJson as Theme

/**
 * Forest — Dark green theme (nature-inspired, calming aesthetics)
 */
export const FOREST_THEME: Theme = forestJson as Theme

/**
 * Petals — Pink/Dark theme
 */
export const PETALS_THEME: Theme = petalsJson as Theme

/**
 * All preset themes in display order.
 * Order determines rendering in the theme selector dropdown.
 */
export const PRESET_THEMES: Theme[] = [
  MIDNIGHT_THEME,
  DAWN_THEME,
  FOREST_THEME,
  PETALS_THEME,
]

/**
 * The default fallback theme used when:
 * - A user theme fails validation
 * - A theme token is missing and needs a default value
 * - The app first launches with no saved preference
 */
export const DEFAULT_THEME = MIDNIGHT_THEME
