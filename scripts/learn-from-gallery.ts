/**
 * scripts/learn-from-gallery.ts
 *
 * Weekly learning loop. Samples curated Japanese YouTube thumbnails from
 * thumbnail-gallery.net (SAMUNE), asks Claude Vision what is visually working
 * in them right now, and turns that into one short clause per concept which
 * lib/gallery-insights.ts appends to the generation prompts.
 *
 *   npm run learn-gallery                  (needs ANTHROPIC_API_KEY)
 *   npm run learn-gallery -- --dry-run     (analyse, print, write nothing)
 *
 * WHY SAMUNE
 * It is a designer-curated gallery ("layout / 文字処理 / 配色 の参考"), i.e.
 * a human already filtered for thumbnails worth imitating. Its WordPress REST
 * API exposes the whole corpus (~2,600 posts) with the featured image URL, so
 * a full sample costs a handful of requests instead of scraping 27 HTML pages.
 * Note the listing HTML lazy-loads images (`src` is a placeholder SVG, the real
 * URL is in `data-src`), which is exactly the trap the REST API avoids.
 *
 * COPYRIGHT — THE RULE THIS SCRIPT IS BUILT AROUND
 * These are third-party thumbnails belonging to real channels. This script:
 *   - NEVER writes an image to disk. Bytes are fetched, sent to the model,
 *     and dropped when the function returns.
 *   - keeps only short, general written observations (palette, light,
 *     contrast, mood) — the sort of thing a designer would write in a notebook.
 *   - explicitly forbids the model from describing, naming or reproducing any
 *     individual thumbnail, and drops any clause that leaks specifics.
 * Reading images to extract statistical tendencies is information analysis;
 * storing a corpus or generating lookalikes of a specific work is not, and
 * this script is written to stay firmly on the first side of that line.
 */
import Anthropic from '@anthropic-ai/sdk';
import { promises as fs } from 'fs';
import path from 'path';
import { CONCEPT_KEYS } from '../lib/concept-keys';

const API = 'https://thumbnail-gallery.net/wp-json/wp/v2/posts';
const OUT = path.join(process.cwd(), 'references', 'gallery-insights.json');

// Identify the crawler honestly and give a contact route. robots.txt permits
// everything outside /wp-admin/, but a weekly job should still be nameable.
const UA =
  'quickthumb-gallery-learner/1.0 (+https://quickthumb.app; weekly design-trend sampling; contact loijgtnhfv@gmail.com)';

// How many thumbnails to look at per run. 36 in 3 batches of 12 keeps the
// vision bill around $0.05/run while still being a wide enough sample that one
// unusual week doesn't swing the guidance.
const SAMPLE_SIZE = 36;
const BATCH_SIZE = 12;

// How many extra random pages to pull besides page 1. Sampling the back
// catalogue (rather than always the newest) matters because the site's newest
// posts are largely untagged — the curated, genre-tagged material is older.
// The page COUNT is read from the API's X-WP-TotalPages header, never assumed:
// the corpus grows ~6-7 posts a week and a hard-coded number would slowly stop
// covering the newest end of it.
const EXTRA_PAGES = 2;

const MODEL = 'claude-haiku-4-5-20251001';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Post = {
  id: number;
  date: string;
  title?: { rendered?: string };
  _embedded?: { 'wp:featuredmedia'?: { source_url?: string }[] };
};

type Sample = { id: number; title: string; imageUrl: string };

async function fetchPage(page: number): Promise<{ samples: Sample[]; totalPages: number }> {
  const url = `${API}?per_page=100&page=${page}&_embed=1`;
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    console.warn(`  page ${page}: HTTP ${res.status} — skipping`);
    return { samples: [], totalPages: 0 };
  }
  // WordPress reports the page count for the per_page we asked for.
  const totalPages = Number(res.headers.get('x-wp-totalpages') ?? 0) || 0;
  const posts = (await res.json()) as Post[];
  const samples = posts.flatMap((p) => {
    const imageUrl = p._embedded?.['wp:featuredmedia']?.[0]?.source_url;
    if (!imageUrl) return [];
    // Titles are HTML-encoded and only used to give the model a hint of subject
    // matter; strip tags/entities rather than pull in a parser.
    const title = (p.title?.rendered ?? '')
      .replace(/<[^>]*>/g, '')
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&amp;/g, '&')
      .trim();
    return [{ id: p.id, title, imageUrl }];
  });
  return { samples, totalPages };
}

function pickRandom<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

type ImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/webp'; data: string };
};

/** Fetch image bytes straight into a base64 block. Nothing touches the disk. */
async function toImageBlock(url: string): Promise<ImageBlock | null> {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    const media_type = ct.includes('png') ? 'image/png' : ct.includes('webp') ? 'image/webp' : 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    // Skip anything implausible as a thumbnail (error pages, 1px trackers).
    if (buf.byteLength < 5_000 || buf.byteLength > 5_000_000) return null;
    return { type: 'image', source: { type: 'base64', media_type, data: buf.toString('base64') } };
  } catch {
    return null;
  }
}

const OBSERVE_PROMPT = `These are curated Japanese YouTube thumbnails, shown to you as a sample of what currently performs well.

Describe the GENERAL visual tendencies you see ACROSS this batch. Write 4-6 short bullet points covering only:
- colour palette and saturation
- lighting and contrast
- background treatment (flat colour, blur, texture, depth)
- overall mood and energy level
- how much of the frame is left visually empty

Rules:
- Describe the batch as a group. Do NOT describe, identify, summarise or single out any individual image, person, channel or piece of text in them.
- Do NOT mention layout, text placement, font choice, or where elements sit in the frame.
- No preamble. Bullet points only.`;

function synthesisPrompt(observations: string[]): string {
  return `You maintain the prompt library of an AI YouTube-thumbnail generator. Below are this week's observations about what is visually working in curated Japanese thumbnails:

${observations.map((o, i) => `--- batch ${i + 1} ---\n${o}`).join('\n\n')}

The generator has these styles, each with a fully-specified prompt that already fixes composition, the reserved text zone, and typography:

${CONCEPT_KEYS.join('\n')}

For each style, write ONE short English sentence to APPEND to its prompt, nudging the model toward this week's tendencies.

Hard rules — a sentence that breaks any of these is worse than no sentence:
- Refer ONLY to colour, saturation, lighting, contrast, background treatment, or mood.
- NEVER mention text, fonts, lettering, captions, words, layout, composition, or where anything is placed. Those are already specified and your sentence must not contradict them.
- Under 160 characters. One sentence. No lists.
- Written as an instruction to an image model, e.g. "Push the colour grade slightly cooler and raise contrast between the subject and the background."
- It must SUIT that particular style. A calm premium style and an explosive action style must not receive the same sentence, and neither should be pushed away from its own character.
- If this week's observations offer nothing useful for a style, return an empty string for it rather than inventing filler.

Reply with ONLY this JSON, no preamble, no code fences:
{${CONCEPT_KEYS.map((k) => `"${k}":"..."`).join(',')}}`;
}

// Belt-and-braces: even with the rules above, refuse any clause that reaches
// for layout or typography. Those words appearing at all means the model
// drifted, and appending it could fight a validated prompt.
//
// The suffixes are pinned deliberately rather than using a blanket \w*: the
// vocabulary this filter must ALLOW overlaps the vocabulary it must block.
// "textured" and "texture" describe a background and have to pass, while
// "text"/"texts" must not; "topic" has to pass, while "top" must not;
// "brightness" has to pass, while "right" must not (the \b handles that one).
const FORBIDDEN =
  /\b(texts?|fonts?|typefaces?|typograph\w*|letter(s|ing)?|words?|caption\w*|headlines?|titles?|layouts?|composition\w*|composed?|lefts?|rights?|tops?|bottoms?|corners?|cent(re|er)(ed|ing)?|placed?|placement|position\w*|align\w*|margins?)\b/i;

function sanitize(clause: unknown): string {
  if (typeof clause !== 'string') return '';
  const s = clause.trim().replace(/\s+/g, ' ');
  if (!s || s.length > 160) return '';
  if (FORBIDDEN.test(s)) return '';
  return s;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set — nothing to do.');
    process.exit(1);
  }

  // Page 1 first — it carries this week's additions AND tells us how many
  // pages exist, which decides where the back-catalogue samples come from.
  const candidates: Sample[] = [];
  const first = await fetchPage(1);
  const totalPages = first.totalPages || 1;
  console.log(`  page 1: ${first.samples.length} posts (${totalPages} pages total)`);
  candidates.push(...first.samples);

  const backCatalogue = Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) => i + 2);
  for (const page of pickRandom(backCatalogue, EXTRA_PAGES)) {
    await sleep(1000); // be a polite guest
    const got = await fetchPage(page);
    console.log(`  page ${page}: ${got.samples.length} posts`);
    candidates.push(...got.samples);
  }
  if (candidates.length === 0) {
    console.error('No posts returned — the API shape may have changed. Leaving insights untouched.');
    process.exit(1);
  }

  const chosen = pickRandom(candidates, SAMPLE_SIZE);
  console.log(`Fetching ${chosen.length} images (kept in memory only) ...`);

  const anthropic = new Anthropic({ apiKey });
  const observations: string[] = [];

  for (let i = 0; i < chosen.length; i += BATCH_SIZE) {
    const batch = chosen.slice(i, i + BATCH_SIZE);
    const blocks: ImageBlock[] = [];
    for (const s of batch) {
      const block = await toImageBlock(s.imageUrl);
      if (block) blocks.push(block);
      await sleep(300);
    }
    if (blocks.length < 3) {
      console.warn(`  batch ${i / BATCH_SIZE + 1}: only ${blocks.length} images fetched — skipping`);
      continue;
    }
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 600,
      messages: [{ role: 'user', content: [...blocks, { type: 'text', text: OBSERVE_PROMPT }] }],
    });
    const text = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '';
    if (text) {
      observations.push(text);
      console.log(`  batch ${i / BATCH_SIZE + 1}: ${blocks.length} images -> ${text.split('\n').length} notes`);
    }
  }

  if (observations.length === 0) {
    console.error('No observations produced — leaving the existing insights untouched.');
    process.exit(1);
  }

  console.log('Synthesising per-style guidance ...');
  const synth = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: synthesisPrompt(observations) }],
  });
  const raw = synth.content[0]?.type === 'text' ? synth.content[0].text.trim() : '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('Synthesis returned no JSON — leaving the existing insights untouched.');
    process.exit(1);
  }

  const parsed = JSON.parse(match[0]) as Record<string, unknown>;
  const byConcept: Record<string, string> = {};
  let dropped = 0;
  for (const key of CONCEPT_KEYS) {
    const clean = sanitize(parsed[key]);
    if (clean) byConcept[key] = clean;
    else if (parsed[key]) dropped++;
  }

  const out = {
    generated_at: new Date().toISOString().slice(0, 10),
    source: 'thumbnail-gallery.net (SAMUNE)',
    sampled: chosen.length,
    note: 'Written by scripts/learn-from-gallery.ts. Images are never stored — only these written observations. Consumed by lib/gallery-insights.ts.',
    observations,
    byConcept,
  };

  console.log(
    `\n${Object.keys(byConcept).length}/${CONCEPT_KEYS.length} styles got guidance` +
      (dropped ? ` (${dropped} rejected by the layout/typography filter)` : '')
  );
  for (const [k, v] of Object.entries(byConcept)) console.log(`  ${k}: ${v}`);

  if (dryRun) {
    console.log('\n--dry-run: not writing.');
    return;
  }
  await fs.writeFile(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`\nWrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error('learn-from-gallery failed:', err);
  process.exit(1);
});
