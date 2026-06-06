// Rasterize favicon.svg -> a 180x180 OPAQUE PNG apple-touch-icon. iOS does not
// render SVG touch icons, and wants an opaque square (it applies its own rounded
// mask), so we flatten the rounded-corner SVG onto its own dark background.
// Run: node scripts/gen-apple-icon.mjs
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'public', 'favicon.svg'));

await sharp(svg, { density: 512 })
  .resize(180, 180, { fit: 'contain', background: '#0a0a0f' })
  .flatten({ background: '#0a0a0f' })
  .png()
  .toFile(join(root, 'public', 'apple-touch-icon.png'));

console.log('wrote public/apple-touch-icon.png (180x180, opaque)');
