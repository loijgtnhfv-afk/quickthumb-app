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
  return `I'm showing you ${count} reference YouTube thumbnails representative of the "${style}" category — ${STYLE_BRIEF[style]}.

Your job: extract the VISUAL STYLE these examples share, as a compact paragraph (around 60–100 words) that I can append to an AI image generation prompt for Flux. The paragraph should describe ONLY style — composition, palette, lighting, mood, subject framing, depth-of-field, typography vibe (if relevant), and any recurring visual motifs.

Do NOT describe specific content (e.g. "a person holding a phone"). Do NOT mention text overlays, captions, or any rendered text on the images. Do NOT use lists or bullet points — return one flowing paragraph of prompt-ready descriptors separated by commas.

Reply with ONLY the descriptor paragraph. No preamble, no quotes, no markdown.`;
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
  const result: typeof existing = { ...existing };
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
