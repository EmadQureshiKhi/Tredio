import type { MetadataRoute } from "next";

/**
 * The installable app. Colors are the dark theme's tokens (--bg), which the icons share, so the
 * splash screen and the status bar match the app's default look.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Tredio",
    short_name: "Tredio",
    description: "Trade what the world pays attention to: outcome markets, attention perps and asset perps, from one passkey.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#09090b",
    theme_color: "#09090b",
    categories: ["finance"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Markets", url: "/", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
      { name: "Portfolio", url: "/portfolio", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
    ],
  };
}
