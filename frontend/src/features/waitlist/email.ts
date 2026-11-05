/**
 * The backend's email check (backend/src/waitlist/routes.ts), so the form refuses the same addresses
 * before sending: the HTML email input's rule, with a dotted domain and a real top-level label.
 */
export const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Why `value` cannot join the waitlist, or null when it can. */
export function emailError(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (!email) return "Enter your email address.";
  if (email.length > 254) return "That email address is too long.";
  return EMAIL.test(email) ? null : "Enter a valid email address.";
}

/** "you@example.com" shortened to fit a narrow line, keeping the domain whole. */
export function shortEmail(email: string, max = 26): string {
  if (email.length <= max) return email;
  const at = email.lastIndexOf("@");
  const domain = email.slice(at);
  const keep = Math.max(3, max - domain.length - 1);
  return `${email.slice(0, keep)}…${domain}`;
}
