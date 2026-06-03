/**
 * One-off: generate the social/OG share image at public/og-image.png (1200x630).
 * Faceless, brand-styled, generated with Nano Banana Pro then cropped to OG size.
 *
 *   node_modules/.bin/tsx scripts/gen-og.ts
 *
 * Needs only REPLICATE_API_TOKEN (read from .env.local, never printed).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Replicate from 'replicate';
import sharp from 'sharp';

const raw = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
if (!process.env.REPLICATE_API_TOKEN) {
  console.error('REPLICATE_API_TOKEN missing');
  process.exit(1);
}

const PROMPT =
  'A clean, premium promotional banner image for a SaaS, NO people. Deep purple-to-indigo diagonal gradient background (from #0f0c29 to #302b63) with soft glowing light. Centered, very large bold white text reading EXACTLY the single word "Quickthumb", and directly below it a smaller crisp tagline reading EXACTLY "Paste a URL. Win the click." On the right, a sleek floating YouTube-style 16:9 video thumbnail card with a red play button. Modern, high-end, lots of clean negative space, sharp legible typography. 16:9.';

async function main() {
  const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  const out = await replicate.run('google/nano-banana-pro', {
    input: { prompt: PROMPT, image_input: [], aspect_ratio: '16:9', resolution: '2K', output_format: 'jpg' },
  });
  let item: unknown = Array.isArray(out) ? out[0] : out;
  let bytes: Buffer | null = null;
  if (item && typeof (item as { blob?: () => Promise<Blob> }).blob === 'function') {
    bytes = Buffer.from(await (await (item as { blob: () => Promise<Blob> }).blob()).arrayBuffer());
  } else {
    const url =
      typeof item === 'string'
        ? item
        : item && typeof (item as { url?: () => string }).url === 'function'
        ? String((item as { url: () => string }).url())
        : undefined;
    if (url) bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  }
  if (!bytes) throw new Error('no image');
  // Crop/resize to the standard OG size 1200x630.
  const og = await sharp(bytes).resize(1200, 630, { fit: 'cover', position: 'center' }).png().toBuffer();
  writeFileSync(join(process.cwd(), 'public', 'og-image.png'), og);
  console.log(`Wrote public/og-image.png (${(og.length / 1024).toFixed(0)}KB)`);
}
main().catch((e) => {
  console.error('gen-og failed:', e);
  process.exit(1);
});
