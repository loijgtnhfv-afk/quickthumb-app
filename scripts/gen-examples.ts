/**
 * Generate the landing-page example gallery through the REAL production
 * pipeline (NBP_CONCEPTS + generateNbpThumbnail), so the samples shown to
 * visitors are honest, representative output.
 *
 * Legal note: the "creator" face in the samples is an AI-generated FICTIONAL
 * persona (generated here, step 1) — never a real person — so publishing the
 * samples raises no right-of-publicity issue. The persona portrait is kept in
 * .preview-examples/persona.png so future marketing assets can reuse the same
 * fictional creator.
 *
 *   node_modules/.bin/tsx scripts/gen-examples.ts portrait   # 1 img  (~$0.13)
 *   node_modules/.bin/tsx scripts/gen-examples.ts samples    # 4 imgs (~$0.54)
 *   node_modules/.bin/tsx scripts/gen-examples.ts samples jp-telop   # regen one
 *   node_modules/.bin/tsx scripts/gen-examples.ts publish    # -> public/examples/*.jpg
 *
 * Needs only REPLICATE_API_TOKEN (read from .env.local, never printed).
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Replicate from 'replicate';
import sharp from 'sharp';
import { NBP_MODEL, NBP_CONCEPTS, generateNbpThumbnail } from '../lib/nbp';

function loadEnv() {
  const raw = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}
loadEnv();
if (!process.env.REPLICATE_API_TOKEN) {
  console.error('REPLICATE_API_TOKEN missing from .env.local');
  process.exit(1);
}

const OUT_DIR = join(process.cwd(), '.preview-examples');
const PUBLISH_DIR = join(process.cwd(), 'public', 'examples');
const PORTRAIT_PATH = join(OUT_DIR, 'persona.png');

// One sample per concept. Hooks stay close to the prod-validated phrases
// (まさかの結末 / 1日で100万 / I QUIT / 新記録達成) to minimize garble risk;
// topics vary to show range. lang must match each concept's lang in lib/nbp.ts.
const SAMPLES: Record<string, { topic: string; hook: string }> = {
  'face-surprise': {
    topic: 'trying a viral cooking hack at home for the first time',
    hook: 'まさかの結末',
  },
  'jp-telop': {
    topic: 'a one-month extreme money-saving challenge',
    hook: '1ヶ月で10万',
  },
  'global-clean': {
    topic: 'quitting a stable office job to do YouTube full-time',
    hook: 'I QUIT',
  },
  action: {
    topic: 'breaking a world-record speedrun in a retro video game',
    hook: '新記録達成',
  },
};

const PORTRAIT_PROMPT =
  'A photorealistic studio headshot portrait of a fictional Japanese man in his mid-20s, ' +
  'a friendly approachable YouTube content creator with short black hair and a natural smile, ' +
  'looking straight at the camera, plain light gray studio background, soft even lighting, ' +
  'sharp focus on the face, head and shoulders only. This is an entirely fictional person ' +
  'who does not resemble any real individual.';

async function toBytes(out: unknown): Promise<Buffer | null> {
  const item: unknown = Array.isArray(out) ? out[0] : out;
  if (item && typeof (item as { blob?: () => Promise<Blob> }).blob === 'function') {
    const b = await (item as { blob: () => Promise<Blob> }).blob();
    return Buffer.from(await b.arrayBuffer());
  }
  let url: string | undefined;
  if (typeof item === 'string') url = item;
  else if (item && typeof (item as { url?: () => string }).url === 'function') {
    url = String((item as { url: () => string }).url());
  }
  if (!url) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function genPortrait(replicate: Replicate) {
  mkdirSync(OUT_DIR, { recursive: true });
  process.stdout.write('[portrait] generating fictional persona... ');
  const out = await replicate.run(NBP_MODEL, {
    input: {
      prompt: PORTRAIT_PROMPT,
      image_input: [],
      aspect_ratio: '1:1',
      resolution: '1K',
      output_format: 'jpg',
    },
  });
  const bytes = await toBytes(out);
  if (!bytes) throw new Error('portrait: no image returned');
  const png = await sharp(bytes).resize(800, 800, { fit: 'cover' }).png().toBuffer();
  writeFileSync(PORTRAIT_PATH, png);
  console.log(`ok ${(png.length / 1024).toFixed(0)}KB -> ${PORTRAIT_PATH}`);
}

// The prod path takes a URL for the face ref. Upload the local portrait via
// Replicate's files API and use its URL; fall back to a data URI if that fails.
async function portraitRefUrl(replicate: Replicate): Promise<string> {
  const png = readFileSync(PORTRAIT_PATH);
  // Identity ref doesn't need full res — keep the data-URI fallback small.
  const jpeg = await sharp(png).resize(640, 640).jpeg({ quality: 82 }).toBuffer();
  try {
    const file = await replicate.files.create(new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }));
    const url = (file as { urls?: { get?: string } }).urls?.get;
    if (url) return url;
  } catch (e) {
    console.warn('files.create failed, falling back to data URI:', e instanceof Error ? e.message : e);
  }
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

async function genSamples(replicate: Replicate, only?: string) {
  if (!existsSync(PORTRAIT_PATH)) {
    throw new Error('persona.png missing — run `gen-examples.ts portrait` first');
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const refUrl = await portraitRefUrl(replicate);
  for (const concept of NBP_CONCEPTS) {
    if (only && concept.key !== only) continue;
    const sample = SAMPLES[concept.key];
    if (!sample) continue;
    const prompt = concept.build(sample.hook, sample.topic, true); // hasFace = true
    process.stdout.write(`\n[sample:${concept.key}] hook="${sample.hook}" generating... `);
    try {
      const buf = await generateNbpThumbnail({ replicate, prompt, faceRefUrls: [refUrl] });
      writeFileSync(join(OUT_DIR, `${concept.key}.png`), buf);
      console.log(`ok ${(buf.length / 1024).toFixed(0)}KB -> ${concept.key}.png`);
    } catch (e) {
      console.log('ERROR', e instanceof Error ? e.message : String(e));
    }
  }
  console.log(`\nDone. Eyeball ${OUT_DIR}, then run: gen-examples.ts publish`);
}

// Compress the approved PNGs into web-weight JPEGs served from /examples/.
async function publish() {
  mkdirSync(PUBLISH_DIR, { recursive: true });
  for (const key of Object.keys(SAMPLES)) {
    const src = join(OUT_DIR, `${key}.png`);
    if (!existsSync(src)) {
      console.warn(`skip ${key}: ${src} missing`);
      continue;
    }
    const jpeg = await sharp(readFileSync(src)).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    const dest = join(PUBLISH_DIR, `${key}.jpg`);
    writeFileSync(dest, jpeg);
    console.log(`${key}: ${(jpeg.length / 1024).toFixed(0)}KB -> ${dest}`);
  }
}

async function main() {
  const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  const cmd = process.argv[2];
  if (cmd === 'portrait') await genPortrait(replicate);
  else if (cmd === 'samples') await genSamples(replicate, process.argv[3]);
  else if (cmd === 'publish') await publish();
  else {
    console.error('usage: gen-examples.ts portrait | samples [concept] | publish');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('gen-examples failed:', e);
  process.exit(1);
});
