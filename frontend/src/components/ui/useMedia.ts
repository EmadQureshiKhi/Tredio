"use client";
import { useSyncExternalStore } from "react";

/** Whether a media query matches, kept in sync (false during server rendering). */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", notify);
      return () => m.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const useDesktop = () => useMedia("(min-width: 768px)");
