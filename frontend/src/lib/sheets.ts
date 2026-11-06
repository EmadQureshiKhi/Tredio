"use client";
import { create } from "zustand";

/** App-wide panels any screen can open: add funds, withdraw from Hyperliquid, propose a trend and the Mainnet waitlist. */
export type SheetName = "deposit" | "hl-withdraw" | "propose" | "waitlist";

export const useSheets = create<{ current: SheetName | null; open: (s: SheetName) => void; close: () => void }>((set) => ({
  current: null,
  open: (s) => set({ current: s }),
  close: () => set({ current: null }),
}));
