/**
 * scripts/extract-style-descriptors.ts
 *
 * Reads reference thumbnail images from references/<style>/, sends a batch
 * to Claude Vision, asks it to extract a concise "style descriptor" — a
 * paragraph of visual cues (palette, composition, lighting, typography,
 * framing) — and writes the result to references/descriptors.json.
 *
 * That JSON ships with the code and is read by buildStylePrompt() to
 * append style-specific visual guidance to the Flux prompt at runtime.
 * Vision is NOT called at runtime, only here.
 *
 * Run locally:
 *   $env:ANTHROPIC_API_KEY="sk-ant-..."   (PowerShell)
 *   npm run extract-descriptors
 *
 * Cost: ~$0.05–0.15 per full run depending on how many images per style.
 */
import Anthropic from '@anthropic-ai/sdk';
import { promises as fs } from 'fs';
import path from 'path';

const STYLES = ['vlog', 'tech', 'gaming', 'magazine'] as const;
type Style = (typeof STYLES)[number];

// Cap how many images we send per style. Claude's vision context isn't free,
// and 6–8 representative images is plenty for style extraction.
const MAX_IMAGES_PER_STYLE = 8;

const SUPPORTED_EXTENSIONS: Record<string, 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

interface ImagePayload {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    data: string;
  };
}

async function loadImages(dir: string): Promise<ImagePayload[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const candidates = entries
    .filter((name) => {
      const ext = path.extname(name).toLowerCase();
      return ext in SUPPORTED_EXTENSIONS;
    })
    .sort()
    .slice(0, MAX_IMAGES_PER_STYLE);

  const payloads: ImagePayload[] = [];
  for (const name of candidates) {
    const filePath = path.join(dir, name);
    const ext = path.extname(name).toLowerCase();
    const media_type = SUPPORTED_EXTENSIONS[ext];
    const buf = await fs.readFile(filePath);
    payloads.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type,
        data: buf.toString('base64'),
      },
    });
  }
  return payloads;
}

const STYLE_BRIEF: Record<Style, string> = {
  vlog: 'cozy lifestyle / "a day in my life" YouTube thumbnails',
  tech: 'tech tutorial / how-to / explainer YouTube thumbnails',
  gaming: 'gameplay / esports / manga-energy YouTube thumbnails',
  magazine: 'polished editorial / magazine-cover-style YouTube thumbnails',
};

function buildPrompt(style: Style, count: number): string {
  return `You are given ${count} real trending YouTube thumbnails grouped under the "${style}" category — ${STYLE_BRIEF[style]}.

Your job: extract the VISUAL STYLE the set shares, as a compact paragraph (around 60–100 words) to append to an AI image-generation prompt for Flux. Describe ONLY style — composition, palette, lighting, mood, subject framing, depth-of-field, typography vibe (if relevant), and recurring visual motifs.

These are scraped from whatever is trending right now, so they may NOT perfectly fit the category label. That is expected and fine. Regardless, extract the dominant shared visual treatment. Do NOT refuse, do NOT judge whether the images fit the category, do NOT address me, and do NOT mention the images, the category, or yourself. Write in the third person only — never use the words "I" or "you".

Do NOT describe specific content (e.g. "a person holding a phone"). Do NOT mention text overlays, captions, or rendered text. Do NOT use lists or bullet points — return one flowing paragraph of prompt-ready descriptors separated by commas.

Reply with ONLY the descriptor paragraph. No preamble, no quotes, no markdown.`;
}

// Guard against the model refusing or returning meta-commentary instead of a
// clean descriptor. Trending thumbnails are noisy — when the images don't fit
// the category label the model sometimes replies "these don't look like vlogs,
// please share real ones..." which is WORSE than no descriptor, because the
// text gets injected verbatim into the Flux prompt. A real descriptor is a
// comma-separated list of visual cues with no first/second person and no
// apology / refusal language.
function isCleanDescriptor(text: string): boolean {
  const t = text.toLowerCase();
  const redFlags = [
    'i need to', "i'm sorry", 'i apologize', "i can't", 'i cannot', "i'm unable",
    "i'm not able", 'as an ai', "don't appear", 'do not appear', "doesn't appear",
    "doesn't match", "don't match", 'do not match', 'please share', 'please provide',
    "i'd be happy", 'i would be happy', 'happy to extract', "you've shared",
    "you've provided", 'you shared', 'thumbnails you', 'these images', 'i notice',
    'would not be accurate', 'not be accurate or useful',
  ];
  if (redFlags.some((f) => t.includes(f))) return false;
  // A real descriptor never uses first/second-person pronouns as standalone words.
  if (/\b(i|i'm|i'll|you|your|you've|we|us)\b/i.test(text)) return false;
  // Descriptors are comma-separated cue lists — expect several commas and a
  // sane length. A refusal is prose with few commas.
  if ((text.match(/,/g) || []).length < 4) return false;
  if (text.length < 60 || text.length > 1200) return false;
  return true;
}

async function extractForStyle(
  anthropic: Anthropic,
  style: Style,
  refsDir: string
): Promise<{ descriptor: string; imageCount: number } | null> {
  const styleDir = path.join(refsDir, style);
  const images = await loadImages(styleDir);
  if (images.length === 0) {
    console.log(`  [${style}] no images found in ${styleDir} — skipping`);
    return null;
  }
  console.log(`  [${style}] ${images.length} image(s) → Vision...`);
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [
      {
        role: 'user',
        content: [
          ...images,
          { type: 'text', text: buildPrompt(style, images.length) },
        ],
      },
    ],
  });
  const text = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '';
  if (!text) {
    console.warn(`  [${style}] empty response — skipping`);
    return null;
  }
  if (!isCleanDescriptor(text)) {
    console.warn(
      `  [${style}] response looks like a refusal / meta-commentary, not a style descriptor — skipping.\n    got: ${text.slice(0, 140)}...`
    );
    return null;
  }
  return { descriptor: text, imageCount: images.length };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set. Run with:');
    console.error('  $env:ANTHROPIC_API_KEY="sk-ant-..."; npm run extract-descriptors');
    process.exit(1);
  }
  const anthropic = new Anthropic({ apiKey });

  const root = process.cwd();
  const refsDir = path.join(root, 'references');
  const outPath = path.join(refsDir, 'descriptors.json');

  // Read existing so we preserve descriptors for styles that have no fresh
  // image set this run (and so 0-image styles don't wipe out earlier work).
  let existing: Record<string, { descriptor: string; imageCount: number; updatedAt: string }> = {};
  try {
    const raw = await fs.readFile(outPath, 'utf8');
    existing = JSON.parse(raw);
    if (typeof existing !== 'object' || Array.isArray(existing)) existing = {};
  } catch {
    existing = {};
  }

  console.log(`Extracting style descriptors → ${outPath}`);
  // Seed from existing, but drop any previously-stored entry that no longer
  // passes the guard — self-heals refusals/meta-commentary that older runs may
  // have committed before this validation existed.
  const result: typeof existing = {};
  for (const [k, v] of Object.entries(existing)) {
    if (v && typeof v.descriptor === 'string' && isCleanDescriptor(v.descriptor)) {
      result[k] = v;
    } else {
      console.log(`  dropping stale/unclean existing descriptor for "${k}"`);
    }
  }
  for (const style of STYLES) {
    const extracted = await extractForStyle(anthropic, style, refsDir);
    if (extracted) {
      result[style] = {
        descriptor: extracted.descriptor,
        imageCount: extracted.imageCount,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  await fs.writeFile(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log('Done.');
  const updatedStyles = STYLES.filter((s) => result[s]);
  console.log(`Descriptors set for: ${updatedStyles.join(', ') || '(none)'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
