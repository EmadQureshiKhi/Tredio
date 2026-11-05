import localFont from "next/font/local";

/** The app's three faces, loaded once and shared by the root layout and the global error page. */
export const body = localFont({ src: [{ path: "./fonts/font1.woff2", weight: "300", style: "normal" }], variable: "--font-body", display: "swap" });
export const display = localFont({ src: [{ path: "./fonts/font2.woff2", weight: "400", style: "normal" }], variable: "--font-display", display: "swap" });
export const strong = localFont({ src: [{ path: "./fonts/font3.woff2", weight: "500", style: "normal" }], variable: "--font-strong", display: "swap" });

export const fontVariables = `${body.variable} ${display.variable} ${strong.variable}`;
