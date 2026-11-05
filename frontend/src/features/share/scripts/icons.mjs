/**
 * Renders the installable app's icons from the Tredio mark in public/tredio-favicon.svg:
 *
 *   node src/features/share/scripts/icons.mjs
 *
 * - icon-192.png, icon-512.png: purpose "any", a rounded dark tile with the mark.
 * - icon-maskable-192.png, icon-maskable-512.png: purpose "maskable", full bleed, with the mark
 *   inside the 80% safe circle so any launcher shape keeps it whole.
 * - apple-touch-icon.png (180): full bleed and opaque, iOS rounds the corners itself.
 */
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const source = readFileSync(join(root, "public", "tredio-favicon.svg"), "utf8");
const markPath = source.match(/<path d="([^"]+)" fill="(#[0-9A-Fa-f]{6})"/);
if (!markPath) throw new Error("The favicon no longer has a single filled path");
const [, d, markColor] = markPath;
const BG = "#09090b";

// The mark's bounding box in the favicon's 894 x 894 space.
const box = { x: 229.676, y: 190.611, w: 434.647, h: 522.05 };

/** An SVG of `size` with the mark `markHeight` (fraction of the size) tall, centred. */
function tile(size, markHeight, radius) {
  const scale = (size * markHeight) / box.h;
  const tx = size / 2 - (box.x + box.w / 2) * scale;
  const ty = size / 2 - (box.y + box.h / 2) * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius * size}" fill="${BG}"/>
  <path transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(5)})" d="${d}" fill="${markColor}"/>
</svg>`;
}

const out = join(root, "public", "icons");
await mkdir(out, { recursive: true });
const icons = [
  { file: "icon-192.png", size: 192, mark: 0.56, radius: 0.22 },
  { file: "icon-512.png", size: 512, mark: 0.56, radius: 0.22 },
  { file: "icon-maskable-192.png", size: 192, mark: 0.44, radius: 0 },
  { file: "icon-maskable-512.png", size: 512, mark: 0.44, radius: 0 },
  { file: "apple-touch-icon.png", size: 180, mark: 0.5, radius: 0 },
];
for (const i of icons) {
  const image = sharp(Buffer.from(tile(i.size, i.mark, i.radius)), { density: 300 }).resize(i.size, i.size);
  // Full-bleed icons carry no alpha: iOS and maskable launchers expect an opaque square.
  await (i.radius === 0 ? image.flatten({ background: BG }) : image).png({ compressionLevel: 9 }).toFile(join(out, i.file));
  console.log(`public/icons/${i.file}`);
}
