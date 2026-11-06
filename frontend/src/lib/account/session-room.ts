/**
 * Room for a new session. An account holds at most MAX_SESSIONS keys: its sessions, expired ones
 * included (account code v1 never prunes them), plus on v2 its dormant gas keys. An account that
 * signed in on enough devices would otherwise never add another session, so the request that adds
 * one first retires what it must: dormant keys, then expired sessions, then the sessions closest to
 * expiring, never the key being renewed.
 */

/** The account contract's MAX_SESSIONS. */
export const MAX_SESSIONS = 16;

export interface SessionSlot {
  publicKey: string;
  expiresAt: number;
}

/** The keys to retire so one more session fits (empty when there is room). */
export function sessionsToRetire(sessions: readonly SessionSlot[], dormant: readonly string[], nowSec: number, keep: string | null = null): string[] {
  const need = sessions.length + dormant.length - (MAX_SESSIONS - 1);
  if (need <= 0) return [];
  const live = sessions.filter((s) => s.publicKey !== keep).sort((a, b) => a.expiresAt - b.expiresAt);
  const expired = live.filter((s) => s.expiresAt <= nowSec).map((s) => s.publicKey);
  const active = live.filter((s) => s.expiresAt > nowSec).map((s) => s.publicKey);
  return [...dormant, ...expired, ...active].slice(0, need);
}
