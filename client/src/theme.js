export const THEME_STORAGE_KEY = 'intel-theme'

export const THEMES = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'paper', label: 'Paper' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'contrast', label: 'Contrast' },
]

export const DEFAULT_THEME = 'terminal'

const THEME_IDS = new Set(THEMES.map((t) => t.id))

const CHART_VARS = [
  'accent-primary',
  'accent-secondary',
  'accent-blue',
  'bullish',
  'bearish',
  'warning',
  'risk',
  'neutral',
  'text-primary',
  'text-secondary',
  'text-muted',
  'text-disabled',
  'bg-main',
  'bg-subtle',
  'bg-panel',
  'bg-elevated',
  'bg-hover',
  'border-subtle',
  'border-strong',
  'fade',
]

export function isValidTheme(id) {
  return THEME_IDS.has(id)
}

export function getStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (isValidTheme(stored)) return stored
  } catch {
    // ignore storage errors (private mode, etc.)
  }
  return DEFAULT_THEME
}

export function setStoredTheme(id) {
  if (!isValidTheme(id)) return
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id)
  } catch {
    // ignore storage errors
  }
}

export function applyTheme(id) {
  const theme = isValidTheme(id) ? id : DEFAULT_THEME
  document.documentElement.dataset.theme = theme
  return theme
}

/** Read computed CSS color tokens for Recharts / inline JS that cannot use var(). */
export function chartColors() {
  const styles = getComputedStyle(document.documentElement)
  const colors = {}
  for (const name of CHART_VARS) {
    colors[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = styles.getPropertyValue(`--color-${name}`).trim()
  }
  // Also expose kebab keys for convenience
  for (const name of CHART_VARS) {
    colors[name] = styles.getPropertyValue(`--color-${name}`).trim()
  }
  return colors
}

export function linePalette() {
  const c = chartColors()
  return [
    c.accentPrimary || c['accent-primary'],
    c.accentSecondary || c['accent-secondary'],
    c.accentBlue || c['accent-blue'],
    c.bullish,
    c.warning,
    c.fade,
    c.risk,
  ].filter(Boolean)
}
