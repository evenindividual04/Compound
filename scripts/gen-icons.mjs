/**
 * Generates PWA icons using sharp (already in node_modules as a Next.js dep).
 * Produces: public/icons/icon-192.png, icon-512.png, apple-touch-icon.png (180px).
 *
 * The icon is a rounded dark #0a0a0a square with a white "₹" glyph centered.
 * If sharp cannot render SVG text (missing system fonts), falls back to a plain
 * dark square with a white circle (no text) — flagged as a concern in output.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// Resolve sharp from the pnpm content-addressable store
let sharp;
try {
  sharp = require("sharp");
} catch {
  // Try the pnpm .pnpm path
  const pnpmSharp = path.join(
    root,
    "node_modules/.pnpm/sharp@0.34.5/node_modules/sharp"
  );
  sharp = require(pnpmSharp);
}

const outDir = path.join(root, "public/icons");
fs.mkdirSync(outDir, { recursive: true });

const BG = "#0a0a0a";

function makeSvg(size) {
  const r = Math.round(size * 0.18); // border-radius ~18%
  const fontSize = Math.round(size * 0.52);
  const cy = Math.round(size * 0.56); // optical center (slightly below midpoint)
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${BG}"/>
  <text
    x="50%"
    y="${cy}"
    text-anchor="middle"
    dominant-baseline="auto"
    font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    font-size="${fontSize}"
    font-weight="600"
    fill="white"
  >₹</text>
</svg>`
  );
}

function makeFallbackSvg(size) {
  const r = Math.round(size * 0.18);
  const cr = Math.round(size * 0.25);
  const cx = Math.round(size / 2);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${BG}"/>
  <circle cx="${cx}" cy="${cx}" r="${cr}" fill="white" fill-opacity="0.9"/>
</svg>`
  );
}

async function generate(size, filename) {
  const outPath = path.join(outDir, filename);
  let usedFallback = false;

  // Try SVG with text first
  try {
    await sharp(makeSvg(size))
      .resize(size, size)
      .png()
      .toFile(outPath);
  } catch (err) {
    console.warn(`  SVG text render failed for ${filename}: ${err.message}`);
    console.warn(`  Falling back to plain dark square with white circle.`);
    usedFallback = true;
    await sharp(makeFallbackSvg(size))
      .resize(size, size)
      .png()
      .toFile(outPath);
  }

  console.log(`  ${filename} (${size}x${size})${usedFallback ? " [FALLBACK — no glyph]" : ""}`);
  return usedFallback;
}

console.log("Generating PWA icons…");
const results = await Promise.all([
  generate(192, "icon-192.png"),
  generate(512, "icon-512.png"),
  generate(180, "apple-touch-icon.png"),
]);

const anyFallback = results.some(Boolean);
if (anyFallback) {
  console.warn(
    "\nCONCERN: One or more icons used the fallback (plain circle, no ₹ glyph).\n" +
    "Install a system font or use a pre-rendered PNG to get the glyph."
  );
} else {
  console.log("\nAll icons generated successfully.");
}
