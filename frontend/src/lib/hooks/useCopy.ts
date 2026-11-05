"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/toast";

/** Copies text with a toast, and flags `copied` briefly so the button can show a check. */
export function useCopy(ms = 1_500) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    async (text: string, title?: string) => {
      if (!(await copyText(text, title))) return;
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), ms);
    },
    [ms],
  );
  return { copied, copy };
}
