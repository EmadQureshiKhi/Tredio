# Tredio landing page

Marketing site for Tredio, built with Next.js, GSAP, Framer Motion and Lenis.
Its "Launch App" buttons open the trading app, and its Mainnet waitlist form (hero modal and the section before the footer) posts to the backend.
The site is served at tredio.bid, with legal pages at `/terms`, `/privacy` and `/cookies` and a contact page at `/contact`; the operator details they show live in `src/config/legal.js`.
Home page copy lives in `src/config/content.js` (shared by the desktop and phone layouts), the "Built with" logos in `src/config/partners.js`, and `public/llms.txt` describes Tredio for AI agents.
Fonts (Hanken Grotesk and Newsreader, SIL OFL) load through `next/font/google`, so a build needs network access to Google Fonts.
Third-party images, logos and fonts, with their sources and licences, are listed in `ASSETS.md`; the logo, icons, link cards and rendered pictures come from `assets/brand/` (`assets/brand/export.sh`).
The hero film goes in `public/assets/video/hero-vid.mp4`; until it exists the hero shows `hero-poster.webp` without playback controls.

## Setup

```bash
npm ci
cp .env.example .env.local
```

- `NEXT_PUBLIC_APP_URL`: URL of the trading app (default `http://localhost:3000`, the frontend dev server; production `https://app.tredio.bid`).
- `NEXT_PUBLIC_SITE_URL`: public origin of this site for canonical and Open Graph URLs (default `https://tredio.bid`).
- `NEXT_PUBLIC_BACKEND_URL`: the Tredio backend the Mainnet waitlist form posts to (default `http://localhost:4000`; production `https://api.tredio.bid`).
  The backend's `LANDING_URL` must list this site's origin.

## Commands

The frontend also defaults to port 3000, so run the landing page on another port:

```bash
npm run dev -- -p 3002   # http://localhost:3002
npm run build
npm run start -- -p 3002
npm run lint
```
