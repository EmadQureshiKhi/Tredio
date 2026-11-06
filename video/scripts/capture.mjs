// Real captures of the Tredio app for the film, signed out, at a 1600x900 CSS viewport and device
// scale 2 (3200x1800 plates, so the film can push in without going soft).
//
//   node scripts/capture.mjs [base-url]      reads capture.config.json, writes public/captures/
//
// Each entry in `pages` is ONE page load; its `shots` are taken in order on that load (tab clicks,
// typing), so the whole run costs as many page loads as there are pages. Page loads are spaced by
// `gapMs`, because the app reads public NEAR RPCs that rate-limit per IP.
//
// Besides the PNGs it writes public/captures/boxes.json: for every shot, the CSS-pixel box of each
// element with a data-testid, of the headings, of the segmented-control options and of every large
// chart, so the film's overlays (rings, cursors, crops) sit exactly on real elements.
//
// Nothing is staged and nobody signs in: whatever the app shows at capture time is what the film shows.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'capture.config.json'), 'utf8'));
const out = join(root, 'public', 'captures');
mkdirSync(out, { recursive: true });
const base = (process.argv[2] ?? cfg.base).replace(/\/$/, '');
const only = process.argv[3] ? new Set(process.argv[3].split(',')) : null;

// Google Chrome in headless mode (CHROME=/path overrides; CHROMIUM=1 uses Playwright's own build).
const launch = process.env.CHROME ? { executablePath: process.env.CHROME } : process.env.CHROMIUM ? {} : { channel: 'chrome' };
const browser = await chromium.launch({ ...launch, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'en-US', timezoneId: 'UTC' });
// Dev servers' own badges are not part of the product.
await ctx.addInitScript(() => {
  addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = 'nextjs-portal, vite-error-overlay, #__vconsole { display: none !important; } * { caret-color: transparent !important; }';
    document.head.append(style);
  });
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`page error: ${e.message}`));

/** CSS-pixel boxes of the elements the film may point at. */
const boxesOf = () =>
  page.evaluate(() => {
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
    };
    const seen = {};
    const put = (key, el) => {
      const b = r(el);
      if (b[2] < 2 || b[3] < 2) return;
      let k = key;
      for (let i = 2; k in seen; i++) k = `${key}#${i}`;
      seen[k] = b;
    };
    for (const el of document.querySelectorAll('[data-testid]')) put(el.getAttribute('data-testid'), el);
    for (const el of document.querySelectorAll('h1, h2')) put(`${el.tagName.toLowerCase()}:${el.textContent.trim().slice(0, 40)}`, el);
    for (const el of document.querySelectorAll('[role=radio], [role=tab]')) put(`option:${el.textContent.trim().slice(0, 30)}`, el);
    for (const el of document.querySelectorAll('svg, canvas')) {
      const b = el.getBoundingClientRect();
      if (b.width >= 300 && b.height >= 120) put('chart', el);
    }
    for (const el of document.querySelectorAll('header, nav, aside, main')) put(el.tagName.toLowerCase(), el);
    return seen;
  });

const boxes = {};
let first = true;
for (const pg of cfg.pages) {
  if (only && !pg.shots.some((s) => only.has(s.name))) continue;
  if (!first) await page.waitForTimeout(cfg.gapMs ?? 15_000);
  first = false;
  await page.goto(base + (pg.path ?? '/'), { waitUntil: 'load' });
  if (pg.ready) await page.waitForSelector(pg.ready, { state: 'attached', timeout: 90_000 });
  await page.waitForTimeout(pg.wait ?? 4000);
  for (const shot of pg.shots) {
    for (const a of shot.actions ?? []) {
      if (a.click) await page.click(a.click);
      if (a.type) await page.fill(a.type[0], a.type[1]);
      if (a.hover) await page.hover(a.hover);
      if (a.press) await page.keyboard.press(a.press);
      if (a.ready) await page.waitForSelector(a.ready, { timeout: 60_000 });
      if (a.wait) await page.waitForTimeout(a.wait);
    }
    if (shot.scrollY !== undefined) await page.evaluate((y) => window.scrollTo(0, y), shot.scrollY);
    // The pointer rests off the page so no hover state shows.
    await page.mouse.move(1599, 899);
    await page.waitForTimeout(shot.wait ?? 1500);
    await page.screenshot({ path: join(out, `${shot.name}.png`), fullPage: Boolean(shot.fullPage) });
    boxes[shot.name] = await boxesOf();
    console.log(`captured ${shot.name}`);
  }
}
await browser.close();

const file = join(out, 'boxes.json');
let previous = {};
try {
  previous = JSON.parse(readFileSync(file, 'utf8'));
} catch {}
writeFileSync(file, `${JSON.stringify({ ...previous, ...boxes }, null, 1)}\n`);
console.log(`wrote ${file}`);
