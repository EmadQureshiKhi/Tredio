import type { NextConfig } from "next";

/**
 * No framing (session trades need no prompt, so a framing page could click for the user), no
 * plugins, no foreign form targets, and passkeys only for this origin.
 */
const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self)" },
];

const nextConfig: NextConfig = {
  headers: async () => [{ source: "/:path*", headers: SECURITY_HEADERS }],
  // Keeps `next dev` from writing its own instruction files into the project.
  agentRules: false,
  // A second build (an end-to-end run beside the running panel) writes its own directory.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // A routing-level redirect: a redirect() in a page would sit behind the sign-in gate.
  // The system view is the landing page: whether everything works comes first.
  redirects: async () => [{ source: "/", destination: "/system", permanent: false }],
};

export default nextConfig;
