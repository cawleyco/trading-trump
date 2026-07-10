import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import {
  THEMES,
  applyTheme,
  getStoredTheme,
  setStoredTheme,
} from './theme.js'

const ThemeContext = createContext(null)

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => applyTheme(getStoredTheme()))

  const setTheme = useCallback((id) => {
    const next = applyTheme(id)
    setStoredTheme(next)
    setThemeState(next)
  }, [])

  const cycleTheme = useCallback(() => {
    const idx = THEMES.findIndex((t) => t.id === theme)
    const next = THEMES[(idx + 1) % THEMES.length]
    setTheme(next.id)
  }, [theme, setTheme])

  const value = useMemo(
    () => ({ theme, setTheme, cycleTheme, themes: THEMES }),
    [theme, setTheme, cycleTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
