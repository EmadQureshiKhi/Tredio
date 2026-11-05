"use client";
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

/**
 * Light, dark or the system's choice. The choice lives on <html data-theme> (set before first
 * paint by THEME_SCRIPT) and in localStorage.
 */
export type ThemeChoice = "system" | "light" | "dark";
export const THEME_KEY = "tredio.theme";
const KEY = THEME_KEY;
const EVENT = "tredio-theme";

export const THEME_SCRIPT = `try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

function read(): ThemeChoice {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
}

function subscribe(notify: () => void) {
  window.addEventListener(EVENT, notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(EVENT, notify);
    window.removeEventListener("storage", notify);
  };
}

const ThemeContext = createContext<{ choice: ThemeChoice; setChoice: (c: ThemeChoice) => void }>({ choice: "system", setChoice: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const choice = useSyncExternalStore(subscribe, read, () => "system" as ThemeChoice);
  const setChoice = useCallback((c: ThemeChoice) => {
    if (c === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = c;
    try {
      if (c === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, c);
    } catch {
      // Storage blocked: the choice lasts this visit.
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return <ThemeContext.Provider value={{ choice, setChoice }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
