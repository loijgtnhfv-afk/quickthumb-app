/**
 * Validate the FACELESS path: what a user who does NOT upload a face photo
 * gets. This is the default first-run experience, so it must still look good.
 * Runs all NBP_CONCEPTS with hasFace=false and no image reference.
 *
 *   node_modules/.bin/tsx scripts/preview-nbp-faceless.ts
 *
 * Needs only REPLICATE_API_TOKEN (read from .env.local, never printed).
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

const TOPIC = 'a surprising 24-hour money-making challenge';
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
    const prompt = concept.build(hook, TOPIC, false); // hasFace = false
    process.stdout.write(`\n[faceless:${concept.key}] hook="${hook}" generating... `);
    try {
      const buf = await generateNbpThumbnail({ replicate, prompt, faceRefUrls: [] });
      writeFileSync(join(outDir, `faceless-${concept.key}.png`), buf);
      console.log(`ok ${(buf.length / 1024).toFixed(0)}KB -> faceless-${concept.key}.png`);
    } catch (e) {
      console.log('ERROR', e instanceof Error ? e.message : String(e));
    }
  }
  console.log(`\nDone. Open ${outDir}`);
}

main().catch((e) => {
  console.error('faceless preview failed:', e);
  process.exit(1);
});
