/**
 * Offline preview harness for "face-hero" mode (appeal pivot v1).
 *
 * Faithfully reproduces the prod /api/generate face path WITHOUT auth/Supabase/
 * YouTube/Anthropic: feed a real channel avatar URL directly + hand-written hooks,
 * run Replicate remove-bg (same model as getFaceCutout), then composeFaceHero +
 * composeThumbnail across all 4 styles. Writes PNGs to .preview/ for eyeballing.
 *
 *   node_modules/.bin/tsx scripts/preview-face-hero.ts
 *
 * Only REPLICATE_API_TOKEN is needed (read from .env.local, never printed).
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Replicate from 'replicate';
import {
  composeThumbnail,
  composeFaceHero,
  styleBackdrop,
  ALL_STYLES,
  type ThumbnailStyle,
} from '../lib/thumbnail-compose';

// --- load REPLICATE_API_TOKEN from .env.local without echoing it -------------
function loadEnv() {
  try {
    const raw = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    }
  } catch {}
}
loadEnv();
if (!process.env.REPLICATE_API_TOKEN) {
  console.error('REPLICATE_API_TOKEN missing from .env.local');
  process.exit(1);
}

// --- copies of the prod helpers (route.ts) so this is a faithful repro -------
function upsizeAvatarUrl(url: string): string {
  return url.replace(/=s\d+(-c)?/, '=s800-c').replace(/\/s\d+-/, '/s800-');
}

let bgRemoverVersion: string | null = null;
async function resolveBgRemover(replicate: Replicate): Promise<string | null> {
  if (bgRemoverVersion) return bgRemoverVersion;
  const m = (await replicate.models.get('lucataco', 'remove-bg')) as {
    latest_version?: { id?: string };
  };
  bgRemoverVersion = m.latest_version?.id ?? null;
  return bgRemoverVersion;
}

async function getFaceCutout(avatarUrl: string): Promise<Buffer | null> {
  const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  const version = await resolveBgRemover(replicate);
  if (!version) return null;
  const out = await replicate.run(
    `lucataco/remove-bg:${version}` as `${string}/${string}:${string}`,
    { input: { image: upsizeAvatarUrl(avatarUrl) } }
  );
  let url: string | undefined;
  if (typeof out === 'string') url = out;
  else if (Array.isArray(out) && typeof out[0] === 'string') url = out[0];
  else if (out && typeof (out as { url?: () => string }).url === 'function') {
    url = (out as { url: () => string }).url();
  }
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

// --- test subjects: hooks hand-written per analyzeForThumbnail spec ----------
// (EN <= 4 words, JP <= 8 chars, in the title's own language). Order maps to
// ALL_STYLES = [vlog, tech, gaming, magazine].
const SUBJECTS: { label: string; avatarUrl: string; hooks: string[] }[] = [
  {
    label: 'mrbeast-globalface',
    avatarUrl:
      'https://yt3.googleusercontent.com/nxYrc_1_2f77DoBadyxMTmv7ZpRZapHR5jbuYe7PlPd5cIRJxtNNEYyOC0ZsxaDyJJzXrnJiuDE=s900-c-k-c0x00ffffff-no-rj',
    hooks: ['I QUIT', '$1M GONE', 'GONE WRONG', 'LAST ONE WINS'],
  },
  {
    label: 'hikakin-jpface',
    avatarUrl:
      'https://yt3.googleusercontent.com/kTCjv_Oh6U18R1VgElKFG3xDOK9xM1m9FcNCQkQHEP3dFEDjDoBj7DIhL7r0wVl94L9G_onKIZ4=s900-c-k-c0x00ffffff-no-rj',
    hooks: ['まさかの', '新記録', '1日で激変', 'ヤバすぎた'],
  },
  {
    label: 'apple-logo',
    avatarUrl:
      'https://yt3.googleusercontent.com/s5hlNKKDDQWjFGzYNnh8UeOW2j2w6id-cZGx7GdAA3d5Fu7zEi7ZMXEyslysuQUKigXNxtAB=s900-c-k-c0x00ffffff-no-rj',
    hooks: ['NEW ERA', 'vs PRO', 'INSANE', 'FIRST LOOK'],
  },
];

async function main() {
  const outDir = join(process.cwd(), '.preview');
  mkdirSync(outDir, { recursive: true });
  for (const subj of SUBJECTS) {
    process.stdout.write(`\n[${subj.label}] removing bg... `);
    const cutout = await getFaceCutout(subj.avatarUrl);
    if (!cutout) {
      console.log('FAILED (no cutout)');
      continue;
    }
    writeFileSync(join(outDir, `${subj.label}__cutout.png`), cutout);
    console.log(`cutout ${(cutout.length / 1024).toFixed(0)}KB. composing...`);
    await Promise.all(
      ALL_STYLES.map(async (style: ThumbnailStyle, i: number) => {
        const backdrop = await styleBackdrop(style);
        const hero = await composeFaceHero(backdrop, cutout, style);
        const composed = await composeThumbnail(hero, subj.hooks[i], style);
        writeFileSync(join(outDir, `${subj.label}__${i + 1}-${style}.png`), composed);
        console.log(`  -> ${subj.label}__${i + 1}-${style}.png`);
      })
    );
  }
  console.log(`\nDone. Open ${outDir}`);
}

main().catch((e) => {
  console.error('preview failed:', e);
  process.exit(1);
});
