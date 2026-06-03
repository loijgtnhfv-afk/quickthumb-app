/**
 * Offline prototype/iteration harness for the Nano Banana Pro engine.
 *
 * Drives the SAME lib/nbp.ts code path used by app/api/generate/route.ts, so
 * what you eyeball here is what production will produce. Feeds a real creator
 * face as the identity reference + hand-written hooks, runs all NBP_CONCEPTS,
 * and writes finished 1280x720 thumbnails to .preview-nbp/ for comparison
 * against the old pipeline in .preview/.
 *
 *   node_modules/.bin/tsx scripts/preview-nbp.ts
 *
 * Needs only REPLICATE_API_TOKEN (read from .env.local, never printed).
 * Cost ≈ $0.134 per 2K image.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Replicate from 'replicate';
import { NBP_CONCEPTS, generateNbpThumbnail } from '../lib/nbp';

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

// Same Hikakin face as scripts/preview-face-hero.ts → true apples-to-apples vs .preview/.
const FACE_REF =
  'https://yt3.googleusercontent.com/kTCjv_Oh6U18R1VgElKFG3xDOK9xM1m9FcNCQkQHEP3dFEDjDoBj7DIhL7r0wVl94L9G_onKIZ4=s800-c-k-c0x00ffffff-no-rj';

const TOPIC = 'a surprising 24-hour money-making challenge';

// Hand-written hooks per concept key (in production these come from the
// extended analyzeForThumbnail: native-language + English hooks).
const HOOKS: Record<string, string> = {
  'face-surprise': 'まさかの結末',
  'jp-telop': '1日で100万',
  'global-clean': 'I QUIT',
  'action': '新記録達成',
};

async function main() {
  const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  const outDir = join(process.cwd(), '.preview-nbp');
  mkdirSync(outDir, { recursive: true });
  for (const concept of NBP_CONCEPTS) {
    const hook = HOOKS[concept.key] ?? 'まさかの';
    const prompt = concept.build(hook, TOPIC, true);
    process.stdout.write(`\n[${concept.key}] (${concept.lang}) hook="${hook}" generating... `);
    try {
      const buf = await generateNbpThumbnail({ replicate, prompt, faceRefUrls: [FACE_REF] });
      const file = join(outDir, `${concept.key}.png`);
      writeFileSync(file, buf);
      console.log(`ok ${(buf.length / 1024).toFixed(0)}KB -> ${concept.key}.png`);
    } catch (e) {
      console.log('ERROR', e instanceof Error ? e.message : String(e));
    }
  }
  console.log(`\nDone. Open ${outDir}`);
}

main().catch((e) => {
  console.error('preview-nbp failed:', e);
  process.exit(1);
});
