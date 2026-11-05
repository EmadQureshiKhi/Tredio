import localFont from "next/font/local";

/**
 * The app's three faces, loaded once and shared by the root layout and the global error page.
 * Open fonts (SIL OFL 1.1, licences beside the files): Hanken Grotesk Light and Medium, and
 * Newsreader at its 72pt optical size, Light. The files are Google Fonts' static instances as
 * WOFF2. They stay local fonts on purpose: next/font/google names both Hanken Grotesk weights
 * "Hanken Grotesk", which would merge body and strong into one family and turn strong text light.
 */
export const body = localFont({ src: [{ path: "./fonts/hanken-grotesk-light.woff2", weight: "300", style: "normal" }], variable: "--font-body", display: "swap" });
export const display = localFont({
  src: [{ path: "./fonts/newsreader-display-light.woff2", weight: "300", style: "normal" }],
  variable: "--font-display",
  display: "swap",
  adjustFontFallback: "Times New Roman",
});
export const strong = localFont({ src: [{ path: "./fonts/hanken-grotesk-medium.woff2", weight: "500", style: "normal" }], variable: "--font-strong", display: "swap" });

export const fontVariables = `${body.variable} ${display.variable} ${strong.variable}`;
