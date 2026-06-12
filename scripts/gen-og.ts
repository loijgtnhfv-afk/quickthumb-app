/**
 * Generate the social/OG share image at public/og-image.png (1200x630).
 *
 * v2 (2026-06-12): deterministic sharp/SVG composite — brand gradient + the
 * REAL example thumbnails from public/examples/ (same AI-fictional-persona
 * samples the landing gallery shows), so social shares show actual product
 * output instead of a generic branded card. No API calls, no cost, no
 * text-garble risk (text is vector SVG, images are the committed JPEGs).
 *
 *   node_modules/.bin/tsx scripts/gen-og.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const W = 1200;
const H = 630;

// Front/back sample cards: jp-telop (dense JP idiom, most striking) in front,
// global-clean (clean EN idiom) behind — together they show the JP + global
// localized-thumbnail wedge in one glance.
const CARD_W = 470;
const CARD_H = Math.round((CARD_W * 9) / 16);

function cardDataUri(file: string): string {
  const jpeg = readFileSync(join(process.cwd(), 'public', 'examples', file));
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

async function main() {
  const back = cardDataUri('global-clean.jpg');
  const front = cardDataUri('jp-telop.jpg');

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f0c29"/>
      <stop offset="50%" stop-color="#302b63"/>
      <stop offset="100%" stop-color="#24243e"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#a78bfa" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#a78bfa" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="card"><rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" rx="16"/></clipPath>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <ellipse cx="930" cy="280" rx="520" ry="420" fill="url(#glow)"/>

  <!-- back card: global-clean (EN idiom) -->
  <g transform="translate(700,86) rotate(5)">
    <rect x="10" y="14" width="${CARD_W}" height="${CARD_H}" rx="16" fill="rgba(0,0,0,0.45)"/>
    <g clip-path="url(#card)">
      <image href="${back}" xlink:href="${back}" width="${CARD_W}" height="${CARD_H}" preserveAspectRatio="xMidYMid slice"/>
    </g>
    <rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" rx="16" fill="none" stroke="rgba(255,255,255,0.30)" stroke-width="2"/>
  </g>

  <!-- front card: jp-telop (JP idiom) -->
  <g transform="translate(620,268) rotate(-6)">
    <rect x="12" y="16" width="${CARD_W}" height="${CARD_H}" rx="16" fill="rgba(0,0,0,0.5)"/>
    <g clip-path="url(#card)">
      <image href="${front}" xlink:href="${front}" width="${CARD_W}" height="${CARD_H}" preserveAspectRatio="xMidYMid slice"/>
    </g>
    <rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" rx="16" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="2"/>
  </g>

  <g font-family="Segoe UI, Arial, sans-serif">
    <text x="76" y="262" font-size="86" font-weight="800" fill="#ffffff">Quickthumb</text>
    <text x="80" y="322" font-size="30" fill="rgba(255,255,255,0.85)">Paste a URL. Win the click.</text>
    <text x="80" y="368" font-size="22" fill="rgba(255,255,255,0.62)">Your face + a bold hook</text>
    <text x="80" y="400" font-size="22" fill="rgba(255,255,255,0.62)">4 finished thumbnails in ~60s</text>
  </g>
</svg>`;

  const og = await sharp(Buffer.from(svg)).png().toBuffer();
  writeFileSync(join(process.cwd(), 'public', 'og-image.png'), og);
  console.log(`Wrote public/og-image.png (${(og.length / 1024).toFixed(0)}KB)`);
}

main().catch((e) => {
  console.error('gen-og failed:', e);
  process.exit(1);
});
