/**
 * scripts/bakeoff.ts — engine bake-off, scored rather than eyeballed.
 *
 * Generates the SAME production prompts through two or more image engines and
 * then has Claude Vision read the text back out of every result, so the thing
 * that decides the engine is a number, not a vibe.
 *
 * The number that matters: quickthumb's entire value proposition is a legible
 * Japanese hook baked into the image. CLAUDE.md records Nano Banana Pro at
 * ~85% Japanese text accuracy — i.e. roughly one in seven delivered thumbnails
 * ships with a mangled glyph. This script measures that figure on our own
 * prompts, for each engine, so "switch / don't switch" stops being a guess.
 *
 *   npm run bakeoff                          # nano-banana-pro vs nano-banana-2
 *   npm run bakeoff -- --engines=nbp,nb2     # same, explicit
 *   npm run bakeoff -- --cases=3             # cheaper run
 *   npm run bakeoff -- --no-face             # faceless variants
 *
 * Needs REPLICATE_API_TOKEN and ANTHROPIC_API_KEY in .env.local.
 * OPENAI_API_KEY additionally enables the gpt-image-2 column.
 *
 * Cost: ~$0.13/image (nbp) + ~$0.07/image (nb2) + ~$0.004/image to score.
 * The default 6 cases x 2 engines lands around $1.30.
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Replicate from 'replicate';
import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';
import { NBP_CONCEPTS } from '../lib/nbp';

function loadEnv() {
  const p = join(process.cwd(), '.env.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}
loadEnv();

const OUT_DIR = join(process.cwd(), '.bakeoff');

// Deliberately weighted toward the cases that break text renderers: mixed
// kanji+kana, digits inside Japanese, katakana loanwords, and one Latin
// control. If an engine only wins on the easy ones it hasn't won.
const CASES: { concept: string; hook: string; topic: string }[] = [
  { concept: 'face-surprise', hook: 'まさかの結末', topic: 'a surprising 24-hour money-making challenge' },
  { concept: 'jp-telop', hook: '1ヶ月で10万', topic: 'a one-month extreme money-saving challenge' },
  { concept: 'calm-authority', hook: '新NISAの正解', topic: 'how to choose an index fund for long-term investing' },
  { concept: 'risk-warning', hook: '知らないと損', topic: 'common mistakes that cost you money on your phone plan' },
  { concept: 'soft-lifestyle', hook: '時短メイク', topic: 'an everyday five-minute makeup routine' },
  { concept: 'global-clean', hook: 'I QUIT', topic: 'quitting a stable office job to do YouTube full-time' },
];

// Fictional persona portrait produced by `gen-examples.ts portrait`. Used as
// the identity reference so the face-preservation side is comparable too.
const PORTRAIT_PATH = join(process.cwd(), '.preview-examples', 'persona.png');

type Engine = {
  id: string;
  label: string;
  approxCost: number;
  available: () => boolean;
  generate: (prompt: string, faceRef: string | null) => Promise<Buffer>;
};

const replicate = () => new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

/** Both Google models take the same Replicate input shape. */
function replicateEngine(id: string, slug: `${string}/${string}`, label: string, cost: number): Engine {
  return {
    id,
    label,
    approxCost: cost,
    available: () => !!process.env.REPLICATE_API_TOKEN,
    async generate(prompt, faceRef) {
      const out = await replicate().run(slug, {
        input: {
          prompt,
          image_input: faceRef ? [faceRef] : [],
          aspect_ratio: '16:9',
          resolution: '2K',
          output_format: 'jpg',
        },
      });
      const item: unknown = Array.isArray(out) ? out[0] : out;
      let bytes: Buffer | null = null;
      if (item && typeof (item as { blob?: () => Promise<Blob> }).blob === 'function') {
        bytes = Buffer.from(await (await (item as { blob: () => Promise<Blob> }).blob()).arrayBuffer());
      } else {
        const url =
          typeof item === 'string'
            ? item
            : String((item as { url: () => string }).url?.() ?? '');
        if (url) bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
      }
      if (!bytes) throw new Error(`${id}: no image returned`);
      return sharp(bytes).resize(1280, 720, { fit: 'cover', position: 'center' }).jpeg({ quality: 92 }).toBuffer();
    },
  };
}

// OpenAI's landscape option is 3:2, not 16:9. Cropping to 16:9 removes ~11% of
// the height — and every concept prompt reserves a text zone, often the bottom
// third, so this crop can eat the very thing being measured. Scored on the
// UNCROPPED image for fairness; treat its layout suitability separately.
const openaiEngine: Engine = {
  id: 'gpt-image-2',
  label: 'OpenAI gpt-image-2 (3:2, not 16:9)',
  approxCost: 0.165,
  available: () => !!process.env.OPENAI_API_KEY,
  async generate(prompt) {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: 'gpt-image-2', prompt, size: '1536x1024', quality: 'medium', n: 1 }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`gpt-image-2 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
    const d = json.data?.[0];
    if (d?.b64_json) return Buffer.from(d.b64_json, 'base64');
    if (d?.url) return Buffer.from(await (await fetch(d.url)).arrayBuffer());
    throw new Error('gpt-image-2: no image in response');
  },
};

const ENGINES: Record<string, Engine> = {
  nbp: replicateEngine('nbp', 'google/nano-banana-pro', 'Nano Banana Pro (current)', 0.134),
  nb2: replicateEngine('nb2', 'google/nano-banana-2', 'Nano Banana 2 (Gemini 3.1 Flash)', 0.067),
  openai: openaiEngine,
};

type Score = {
  textSeen: string[];
  hookExact: boolean;
  hookGarbled: boolean;
  extraText: boolean;
  faceLooksReal: boolean;
  note: string;
};

/**
 * Ask Vision to TRANSCRIBE rather than to judge. "Is this correct?" invites
 * agreement; "write down exactly what characters you see" is checkable, and
 * the comparison against the expected hook happens here in code.
 */
async function scoreImage(anthropic: Anthropic, jpg: Buffer, hook: string): Promise<Score> {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpg.toString('base64') } },
          {
            type: 'text',
            text: `Transcribe every piece of text visible in this thumbnail EXACTLY as rendered, character by character. Do not correct spelling, do not guess at what was intended, and do not translate. If a character is malformed, unreadable or looks like an invented glyph, transcribe what is actually drawn and flag it.

Also say whether any human face present looks like a real photograph (as opposed to illustrated, cartoon or distorted).

Reply with ONLY this JSON:
{"text_seen":["..."],"any_malformed_characters":true|false,"face_photographic":true|false|null,"note":"one short sentence"}`,
          },
        ],
      },
    ],
  });
  const raw = msg.content[0]?.type === 'text' ? msg.content[0].text : '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { textSeen: [], hookExact: false, hookGarbled: true, extraText: false, faceLooksReal: false, note: 'unparseable score' };
  const p = JSON.parse(m[0]) as {
    text_seen?: unknown;
    any_malformed_characters?: boolean;
    face_photographic?: boolean | null;
    note?: string;
  };
  const seen = Array.isArray(p.text_seen) ? p.text_seen.map((s) => String(s).trim()).filter(Boolean) : [];
  const norm = (s: string) => s.replace(/[\s「」『』"'’”]/g, '');
  const target = norm(hook);
  const hookExact = seen.some((s) => norm(s) === target);
  return {
    textSeen: seen,
    hookExact,
    hookGarbled: !hookExact || !!p.any_malformed_characters,
    // Anything beyond the hook is the "invented signage" failure NO_EXTRA_TEXT exists to stop.
    extraText: seen.filter((s) => norm(s) !== target).length > 0,
    faceLooksReal: p.face_photographic !== false,
    note: String(p.note ?? '').slice(0, 160),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const useFace = !args.includes('--no-face');
  const caseLimit = Number(arg('cases') ?? CASES.length);
  const wanted = (arg('engines') ?? 'nbp,nb2').split(',').map((s) => s.trim());

  const engines = wanted.map((id) => ENGINES[id]).filter(Boolean);
  if (engines.length === 0) {
    console.error(`No known engines in "${wanted.join(',')}". Known: ${Object.keys(ENGINES).join(', ')}`);
    process.exit(1);
  }
  const unavailable = engines.filter((e) => !e.available());
  if (unavailable.length) {
    console.error(`Missing API key for: ${unavailable.map((e) => e.id).join(', ')}`);
    console.error('Put REPLICATE_API_TOKEN (and OPENAI_API_KEY for gpt-image-2) in .env.local.');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY missing from .env.local — needed to score the results.');
    process.exit(1);
  }

  let faceRef: string | null = null;
  if (useFace) {
    if (!existsSync(PORTRAIT_PATH)) {
      console.error(`No persona portrait at ${PORTRAIT_PATH}.`);
      console.error('Run `npm run gen-examples portrait` first, or pass --no-face.');
      process.exit(1);
    }
    const jpeg = await sharp(readFileSync(PORTRAIT_PATH)).jpeg({ quality: 90 }).toBuffer();
    faceRef = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  }

  const cases = CASES.slice(0, caseLimit);
  const total = cases.length * engines.length;
  const estimate = engines.reduce((sum, e) => sum + e.approxCost * cases.length, 0);
  console.log(
    `Bake-off: ${engines.map((e) => e.id).join(' vs ')} — ${cases.length} cases, ${total} images, ` +
      `face=${useFace ? 'yes' : 'no'}, est. $${estimate.toFixed(2)}\n`
  );

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  mkdirSync(OUT_DIR, { recursive: true });
  const results: Record<string, (Score & { concept: string; hook: string; ms: number; failed?: string })[]> = {};

  for (const engine of engines) {
    results[engine.id] = [];
    mkdirSync(join(OUT_DIR, engine.id), { recursive: true });
    for (const c of cases) {
      const concept = NBP_CONCEPTS.find((x) => x.key === c.concept);
      if (!concept) {
        console.warn(`  unknown concept ${c.concept} — skipping`);
        continue;
      }
      const prompt = concept.build(c.hook, c.topic, useFace);
      process.stdout.write(`[${engine.id}] ${c.concept} "${c.hook}" ... `);
      const t0 = Date.now();
      try {
        const jpg = await engine.generate(prompt, faceRef);
        const ms = Date.now() - t0;
        writeFileSync(join(OUT_DIR, engine.id, `${c.concept}.jpg`), jpg);
        const score = await scoreImage(anthropic, jpg, c.hook);
        results[engine.id].push({ ...score, concept: c.concept, hook: c.hook, ms });
        console.log(
          `${(ms / 1000).toFixed(0)}s | text ${score.hookExact ? 'OK' : 'WRONG'}` +
            `${score.extraText ? ' | +extra text' : ''}${score.faceLooksReal ? '' : ' | face not photographic'}`
        );
        if (!score.hookExact) console.log(`      saw: ${JSON.stringify(score.textSeen)}`);
      } catch (err) {
        const ms = Date.now() - t0;
        const message = err instanceof Error ? err.message : String(err);
        results[engine.id].push({
          concept: c.concept, hook: c.hook, ms, failed: message,
          textSeen: [], hookExact: false, hookGarbled: true, extraText: false, faceLooksReal: false, note: '',
        });
        console.log(`FAILED (${message.slice(0, 120)})`);
      }
    }
    console.log('');
  }

  console.log('='.repeat(72));
  console.log('RESULTS — hook rendered exactly, per engine');
  console.log('='.repeat(72));
  for (const engine of engines) {
    const rs = results[engine.id];
    const done = rs.filter((r) => !r.failed);
    const exact = done.filter((r) => r.hookExact).length;
    const extra = done.filter((r) => r.extraText).length;
    const notPhoto = done.filter((r) => !r.faceLooksReal).length;
    const avgSec = done.length ? done.reduce((s, r) => s + r.ms, 0) / done.length / 1000 : 0;
    const pct = done.length ? Math.round((exact / done.length) * 100) : 0;
    console.log(
      `${engine.label.padEnd(38)} text ${exact}/${done.length} (${pct}%)  ` +
        `extra-text ${extra}  non-photo-face ${notPhoto}  avg ${avgSec.toFixed(0)}s  ` +
        `~$${(engine.approxCost * done.length).toFixed(2)}` +
        (rs.length - done.length ? `  [${rs.length - done.length} failed]` : '')
    );
  }
  console.log('\nPer-case detail:');
  for (const c of cases) {
    const row = engines
      .map((e) => {
        const r = results[e.id].find((x) => x.concept === c.concept);
        if (!r) return `${e.id}:-`;
        if (r.failed) return `${e.id}:ERR`;
        return `${e.id}:${r.hookExact ? 'OK ' : 'BAD'}`;
      })
      .join('  ');
    console.log(`  ${c.hook.padEnd(10)} ${row}`);
  }

  writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify({ cases, results }, null, 2));
  console.log(`\nImages + results.json in ${OUT_DIR}`);
  console.log('Look at the images yourself too — text accuracy is measurable, but "would I click this" is not.');
}

main().catch((err) => {
  console.error('bakeoff failed:', err);
  process.exit(1);
});
