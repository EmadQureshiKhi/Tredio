import path from "node:path";
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
  // The shared packages live in ../packages, so Turbopack resolves from the repo root.
  turbopack: { root: path.join(__dirname, "..") },
  transpilePackages: ["lightweight-charts", "fancy-canvas", "@tredio/autopilot", "@tredio/contracts", "@tredio/hyperliquid"],
  // Keeps `next dev` from writing its own instruction files into the project.
  agentRules: false,
  poweredByHeader: false,
  // End-to-end runs build into their own directory so they never collide with another build.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  devIndicators: false,
  images: { remotePatterns: [{ hostname: "pbs.twimg.com" }, { hostname: "upload.wikimedia.org" }] },
  experimental: {
    // Optimistic routing predicts a link's route from one already seen and keys its params by the
    // raw path segment, while the server keys them by encodeURIComponent. Trend ids carry a colon
    // ("equity:pltr.2"), so a predicted prefetch never matched its response and was re-requested
    // forever. Every route is resolved by the server instead.
    optimisticRouting: false,
  },
};

export default nextConfig;
