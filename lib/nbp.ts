/**
 * Nano Banana Pro (Gemini 3 Pro Image) thumbnail generation.
 *
 * The engine for the appeal pivot v2: instead of "Flux text-free background +
 * Satori paste-text", we ask NBP to generate a FINISHED 16:9 thumbnail in one
 * pass — a hero subject (the creator's real face, passed as an image reference
 * to preserve identity) + a scene + the hook rendered AS legible in-image text
 * (NBP renders Japanese well, ~85%). Validated 2026-06-03 to dramatically beat
 * the old pipeline (see scripts/preview-nbp.ts and the project memory).
 *
 * Shared by app/api/generate/route.ts and scripts/preview-nbp.ts so the offline
 * harness exercises the exact production code path.
 */
import Replicate from 'replicate';
import sharp from 'sharp';

export const NBP_MODEL = 'google/nano-banana-pro' as const;

// A "concept" is a conceptually-different thumbnail idea (NOT a font swap).
// `lang` picks which hook to feed: 'native' = the title's own language (JP for
// JP videos), 'en' = an English hook (the global-localized variant — the
// "one URL → JP + global thumbnail" wedge).
export type NbpConcept = {
  key: string;
  lang: 'native' | 'en';
  /** Short human-facing label (also the i18n fallback string). */
  label: string;
  build: (hook: string, topic: string, hasFace: boolean) => string;
};

// Every prompt RESERVES a text zone away from the face and forbids the subject
// from overlapping the text — this fixes the "head occludes a kanji" collision
// seen in the first prototype (新記[録]達成).
const heroClause = (hasFace: boolean): string =>
  hasFace
    ? 'Use the person in the reference image as the large hero subject and KEEP THEIR FACE AND IDENTITY clearly recognizable (same person)'
    : 'Feature one clear, bold hero subject closely tied to the topic';

const legible = (hook: string): string =>
  `The text must read EXACTLY 「${hook}」, be large, bold and perfectly legible, and must NOT overlap or be covered by the hero subject.`;

// Forbid NBP from inventing extra lettering beyond the hook (scene labels,
// signage, watermarks) — that secondary text is where it garbles (it rendered a
// stray, misspelled "ポケモンテーマパーク" in testing). The hook is the only text.
const NO_EXTRA_TEXT =
  'The hook is the ONLY text in the entire image — do NOT render any other words, captions, labels, signage, logos, numbers or watermarks anywhere, and do not misspell the hook.';

export const NBP_CONCEPTS: NbpConcept[] = [
  {
    key: 'face-surprise',
    lang: 'native',
    label: 'Shocked face + hook',
    build: (hook, topic, hasFace) =>
      `A high-CTR 16:9 YouTube thumbnail about ${topic}. ${heroClause(hasFace)}, with a strong shocked, wide-eyed surprised expression, placed on the RIGHT third of the frame. Warm, bright, vivid lifestyle background with a soft vignette. Keep the LEFT half of the frame clear for text. Place bold text on the LEFT in a heavy white gothic font with a thick black outline. ${legible(hook)} ${NO_EXTRA_TEXT} Punchy, professional, irresistible to click.`,
  },
  {
    key: 'jp-telop',
    lang: 'native',
    label: 'Bold telop + arrow',
    build: (hook, topic, hasFace) =>
      `A high-CTR Japanese-style 16:9 YouTube thumbnail about ${topic}, with bold "telop" graphics. ${heroClause(hasFace)}, smiling confidently and pointing toward the text, placed on the RIGHT. Clean studio background with one bright accent color and a bold red arrow pointing at the text. Put the text on the LEFT in a heavy white-and-yellow gothic font with a thick black outline, plus a small red circular graphic accent (a shape, no lettering). ${legible(hook)} ${NO_EXTRA_TEXT} Energetic Japanese info-content style.`,
  },
  {
    key: 'global-clean',
    lang: 'en',
    label: 'Clean global style',
    build: (hook, topic, hasFace) =>
      `A clean, high-CTR 16:9 YouTube thumbnail about ${topic}, modern global MrBeast style. ${heroClause(hasFace)}, with a dramatic emotional expression, centered slightly upper. Simple bold background, strong studio lighting, shallow depth of field, high contrast. Keep the BOTTOM third clear for text. Place the text across the BOTTOM in a heavy white sans-serif with a subtle shadow. ${legible(hook)} ${NO_EXTRA_TEXT} Minimal, premium, punchy.`,
  },
  {
    key: 'action',
    lang: 'native',
    label: 'Action energy',
    build: (hook, topic, hasFace) =>
      `A high-energy 16:9 YouTube thumbnail about ${topic} with comic-book-style BACKGROUND effects only. ${heroClause(hasFace)}, kept PHOTOGRAPHIC and realistic — NOT illustrated, drawn or cartoon — with an intense excited expression, fist raised, placed CENTER-RIGHT. Dark dramatic background with comic-style vibrant red and orange energy bursts and strong rim light (apply the comic styling to the background and effects, never to the person's face). Reserve a clear band on the LEFT for the text. Place the text on the LEFT in a bright bold yellow font with a thick black outline and a slight skew. ${legible(hook)} ${NO_EXTRA_TEXT} Explosive and exciting.`,
  },
];

// Normalise whatever the replicate client returns (a FileOutput with .blob()/
// .url(), a URL string, or an array of those) into raw image bytes.
async function toImageBytes(out: unknown): Promise<Buffer | null> {
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
  // The output URL is a replicate CDN file; if it hangs, don't let the fetch
  // sit indefinitely after we've already paid for the generation.
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

// Cap how long we wait on a single NBP call. Normal latency is ~40s; if a call
// hangs (e.g. the model can't fetch a reference image), we abort it so the
// request doesn't sit until the function timeout. Aborting via the replicate
// client's signal also tears down the in-flight prediction instead of leaving
// it running server-side (as the old Promise.race did).
const NBP_CALL_TIMEOUT_MS = 90_000;

export type NbpInput = {
  replicate: Replicate;
  prompt: string;
  /** Reference image URL(s) for identity preservation (the creator's face). */
  faceRefUrls?: string[];
  /** Output resolution tier; 2K (~$0.134/img) is the default. */
  resolution?: '1K' | '2K' | '4K';
};

/**
 * Generate one finished thumbnail and return it as a 1280x720 PNG buffer
 * (NBP's pixel dims vary between runs, so we pin them for consistent cards).
 */
export async function generateNbpThumbnail(input: NbpInput): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NBP_CALL_TIMEOUT_MS);
  let out: unknown;
  try {
    out = await input.replicate.run(NBP_MODEL, {
      input: {
        prompt: input.prompt,
        image_input: input.faceRefUrls ?? [],
        aspect_ratio: '16:9',
        resolution: input.resolution ?? '2K',
        output_format: 'jpg',
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`nano-banana-pro timed out after ${NBP_CALL_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const bytes = await toImageBytes(out);
  if (!bytes) throw new Error('Nano Banana Pro returned no image');
  return sharp(bytes).resize(1280, 720, { fit: 'cover', position: 'center' }).png().toBuffer();
}
