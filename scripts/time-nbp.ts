import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Replicate from 'replicate';
import { NBP_CONCEPTS, generateNbpThumbnail } from '../lib/nbp';

const raw = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const topic = 'a 24-hour money-making challenge';
const prompt = (i: number) => NBP_CONCEPTS[i].build('まさかの結末', topic, false);

async function main() {
  const t0 = Date.now();
  await generateNbpThumbnail({ replicate, prompt: prompt(0), faceRefUrls: [] });
  console.log(`SINGLE NBP 2K: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const t1 = Date.now();
  const times: number[] = [];
  await Promise.all(
    NBP_CONCEPTS.map(async (_c, i) => {
      const s = Date.now();
      await generateNbpThumbnail({ replicate, prompt: prompt(i), faceRefUrls: [] });
      times.push((Date.now() - s) / 1000);
    })
  );
  console.log(`PARALLEL x4 wall: ${((Date.now() - t1) / 1000).toFixed(1)}s | per-call: ${times.map((t) => t.toFixed(1)).join(', ')}s`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
