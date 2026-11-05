/**
 * The backend origin the browser calls directly. The backend's FRONTEND_URL (its CORS allowlist)
 * must list this panel's origin. Inlined at build time, like every NEXT_PUBLIC_ variable.
 */
export const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000").replace(/\/+$/, "");

/**
 * Accounts expected to be admins. Only a hint for the sign-in screen: the backend checks its own
 * ADMIN_ADDRESSES on every request, so this list grants nothing.
 */
export const ADMIN_WALLET_HINT: readonly string[] = (process.env.NEXT_PUBLIC_ADMIN_WALLETS ?? "")
  .split(",")
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);
