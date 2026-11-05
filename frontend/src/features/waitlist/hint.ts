/**
 * The waitlist's pre-paint hint (see store.ts): <html data-waitlist> lists what this browser left
 * off with, as tokens: "joined", "row-dismissed" (the Home row on phones) and "card-collapsed" (the
 * sidebar card on desktop). Server components import it, so it lives apart from the client store.
 */

export const WAITLIST_KEY = "tredio.waitlist";

/** The tokens for a stored memory; the pre-paint script below computes the same. */
export function waitlistTokens(m: { joined: unknown[]; rowDismissed: boolean; cardCollapsed: boolean }): string {
  return [m.joined.length > 0 && "joined", m.rowDismissed && "row-dismissed", m.cardCollapsed && "card-collapsed"].filter(Boolean).join(" ");
}

export const WAITLIST_HINT_SCRIPT = `try{var w=JSON.parse(localStorage.getItem("${WAITLIST_KEY}")||"null");if(w){var t=[];if(w.joined&&w.joined.length)t.push("joined");if(w.rowDismissed===true)t.push("row-dismissed");if(w.cardCollapsed===true)t.push("card-collapsed");if(t.length)document.documentElement.dataset.waitlist=t.join(" ")}}catch(e){}`;
