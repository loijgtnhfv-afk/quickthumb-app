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
  // Added 2026-07-27 with the six new concepts. Each topic is chosen to suit
  // the style it demonstrates — a sample that fights its own concept (a calm
  // premium layout showing a speedrun) sells the style badly in the picker.
  // Hooks stay short and use common kanji, same garble-avoidance logic as above.
  'object-spotlight': {
    topic: 'a hands-on review of a new compact camera',
    hook: '買って正解',
  },
  'calm-authority': {
    topic: 'how to choose an index fund for long-term investing',
    hook: '新NISAの正解',
  },
  'split-compare': {
    topic: 'a one-month room decluttering transformation',
    hook: '1ヶ月の変化',
  },
  'risk-warning': {
    topic: 'common mistakes that cost you money on your phone plan',
    hook: '知らないと損',
  },
  'soft-lifestyle': {
    topic: 'an everyday five-minute makeup routine',
    hook: '時短メイク',
  },
  'night-cinematic': {
    topic: 'the night a solo hiker got lost in the mountains',
    hook: 'HE VANISHED',
  },
  // Vtuber / gaming batch. Topics are picked so the sample reads as belonging
  // to that world at a glance — a generic topic here would make the tile look
  // like the photographic ones with a filter on it.
  'anime-style': {
    topic: 'a late-night gaming stream with viewers in chat',
    hook: '初見さん歓迎',
  },
  'game-live': {
    topic: 'a clutch comeback in an online shooter match',
    hook: '神回きた',
  },
};

// Two fictional personas. The samples are what a first-time visitor uses to
// decide whether a style is "for them", so a beauty/lifestyle tile showing a
// man in his mid-20s quietly tells the largest audience for that style that it
// isn't. Both are entirely fictional — no real person's likeness is involved.
const PERSONAS: Record<'default' | 'beauty', { path: string; prompt: string }> = {
  default: {
    path: join(OUT_DIR, 'persona.png'),
    prompt:
      'A photorealistic studio headshot portrait of a fictional Japanese man in his mid-20s, ' +
      'a friendly approachable YouTube content creator with short black hair and a natural smile, ' +
      'looking straight at the camera, plain light gray studio background, soft even lighting, ' +
      'sharp focus on the face, head and shoulders only. This is an entirely fictional person ' +
      'who does not resemble any real individual.',
  },
  beauty: {
    path: join(OUT_DIR, 'persona-beauty.png'),
    prompt:
      'A photorealistic studio headshot portrait of a fictional Japanese woman in her mid-20s, ' +
      'a friendly approachable beauty and lifestyle YouTube creator with shoulder-length dark hair ' +
      'and a natural relaxed smile, looking straight at the camera, plain light gray studio ' +
      'background, soft even lighting, sharp focus on the face, head and shoulders only. ' +
      'This is an entirely fictional person who does not resemble any real individual.',
  },
};

// Which persona each concept's sample uses. Anything unlisted uses `default`.
const SAMPLE_PERSONA: Record<string, keyof typeof PERSONAS> = {
  'soft-lifestyle': 'beauty',
};

const PORTRAIT_PATH = PERSONAS.default.path;

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

async function genPortrait(replicate: Replicate, which: keyof typeof PERSONAS = 'default') {
  mkdirSync(OUT_DIR, { recursive: true });
  const persona = PERSONAS[which];
  process.stdout.write(`[portrait:${which}] generating fictional persona... `);
  const out = await replicate.run(NBP_MODEL, {
    input: {
      prompt: persona.prompt,
      image_input: [],
      aspect_ratio: '1:1',
      resolution: '1K',
      output_format: 'jpg',
    },
  });
  const bytes = await toBytes(out);
  if (!bytes) throw new Error('portrait: no image returned');
  const png = await sharp(bytes).resize(800, 800, { fit: 'cover' }).png().toBuffer();
  writeFileSync(persona.path, png);
  console.log(`ok ${(png.length / 1024).toFixed(0)}KB -> ${persona.path}`);
}

// The prod path takes a URL for the face ref. Upload the local portrait via
// Replicate's files API and use its URL; fall back to a data URI if that fails.
async function portraitRefUrl(replicate: Replicate, path: string): Promise<string> {
  const png = readFileSync(path);
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
  // One ref URL per persona, uploaded on first use.
  const refUrls = new Map<string, string>();
  for (const concept of NBP_CONCEPTS) {
    if (only && concept.key !== only) continue;
    const sample = SAMPLES[concept.key];
    if (!sample) continue;
    const which = SAMPLE_PERSONA[concept.key] ?? 'default';
    const personaPath = PERSONAS[which].path;
    if (!existsSync(personaPath)) {
      console.log(`
[sample:${concept.key}] SKIP — ${personaPath} missing (run: gen-examples.ts portrait ${which})`);
      continue;
    }
    if (!refUrls.has(which)) refUrls.set(which, await portraitRefUrl(replicate, personaPath));
    const refUrl = refUrls.get(which)!;
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
  if (cmd === 'portrait') await genPortrait(replicate, (process.argv[3] as 'default' | 'beauty') || 'default');
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
