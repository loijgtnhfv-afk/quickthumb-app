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
import { CONCEPT_KEYS, DEFAULT_CONCEPT_KEYS, type ConceptKey } from './concept-keys';

/**
 * The image model, switchable from the environment.
 *
 * Moved from google/nano-banana-pro to google/nano-banana-2 (Gemini 3.1 Flash
 * Image) on 2026-07-27 after a measured bake-off — scripts/bakeoff.ts, 15 real
 * Japanese hooks per engine, every disputed result checked by eye:
 *
 *              japanese text   avg latency   cost/image
 *   nbp Pro       14/15           34s          $0.134
 *   nb2           15/15           19s          $0.067
 *
 * So: better text, ~1.8x faster, half the price. The hard cases (ぶっちゃけます,
 * コスパ最強, え、まじ？, 3日で5kg減, 新NISAの正解) all rendered correctly on
 * nb2, while nbp Pro invented a particle — "コスパの最強" — in one of them.
 *
 * Read from the env so a regression can be rolled back by setting NBP_MODEL in
 * Vercel, with no deploy: image quality is subjective and a bake-off is a
 * sample, not a guarantee.
 */
export const NBP_MODEL = (process.env.NBP_MODEL ?? 'google/nano-banana-2') as `${string}/${string}`;

// A "concept" is a conceptually-different thumbnail idea (NOT a font swap).
// `lang` picks which hook to feed: 'native' = the title's own language (JP for
// JP videos), 'en' = an English hook (the global-localized variant — the
// "one URL → JP + global thumbnail" wedge).
export type NbpConcept = {
  /** Typed against the shared list so a typo or a missing style fails to compile. */
  key: ConceptKey;
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

const legible = (hook: string): string => {
  // NBP renders the 「」 corner brackets literally when they wrap a Latin hook
  // (it baked a stray 「I QUIT」), but correctly treats them as quoting
  // punctuation for Japanese (まさかの結末 rendered with no brackets). So only
  // wrap when the hook actually contains CJK/kana; Latin hooks (the global-clean
  // concept) get no brackets. >= 0x3000 covers kana + CJK + fullwidth; Latin and
  // basic punctuation are all below it, so no \u escapes / CJK literals needed.
  const hasCjk = [...hook].some((c) => c.charCodeAt(0) >= 0x3000);
  // JP branch is byte-identical to the prod-validated wording (no leading space);
  // only the Latin branch changes (bare hook, no brackets).
  const phrase = hasCjk ? `precisely「${hook}」` : `precisely ${hook}`;
  return `The text must read ${phrase}, be large, bold and perfectly legible, and must not overlap or be covered by the hero subject.`;
};

// Keep the hook the only text. Two failure modes seen in testing: (a) NBP
// invents stray garbled scene labels (a misspelled "ポケモンテーマパーク"), and
// (b) it renders ALL-CAPS emphasis words from our own prompt as on-image text
// (a literal "EXACTLY" leaked from the old "read EXACTLY" wording). So: forbid
// any extra lettering, and we avoid shouty caps words near the hook elsewhere.
const NO_EXTRA_TEXT =
  'The hook is the only text in the whole image. Do not add any other or decorative words, kicker words or flair text in any language, and no extra captions, labels, signage, logos, numbers or watermarks anywhere. Render the hook characters as given, without misspelling or altering them.';

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
    // REWRITTEN 2026-07-27. The old wording opened with "comic-book-style" and
    // relied on "NOT illustrated, drawn or cartoon" to claw the person back to
    // photographic. It didn't work: in a bake-off BOTH engines returned an
    // illustrated face, which for this product is the worst possible failure —
    // the user's uploaded face is the whole point, and a cartoon of it is not
    // them. Two lessons are baked in here: an image model takes its medium from
    // the FIRST thing it reads, so the sentence now opens "A photorealistic
    // photograph"; and negations are weak, so instead of forbidding "cartoon"
    // we positively describe skin, hair and camera. The word "comic" is gone
    // entirely — the burst effects are now named as the concrete shapes we
    // actually want (radiating lines, halftone dots), which cannot be applied
    // to a face the way a whole-image art style can.
    build: (hook, topic, hasFace) =>
      `A photorealistic 16:9 YouTube thumbnail photograph about ${topic}, shot on a real camera. ${heroClause(hasFace)}, with an intense excited expression and one fist raised, placed CENTER-RIGHT. The person must stay a real photograph throughout — real skin texture, real hair, real photographic lighting — and must never be redrawn, illustrated, stylised, animated or turned into a drawing. BEHIND the person, a dark dramatic background built only from flat graphic shapes: vivid red and orange radiating burst lines, a halftone dot texture, and a strong warm rim light separating them from the background. Those graphic shapes stay strictly in the background and never cross, cover or restyle the person. Reserve a clear band on the LEFT for the text. Place the text on the LEFT in a bright bold yellow font with a thick black outline and a slight skew. ${legible(hook)} ${NO_EXTRA_TEXT} Explosive and exciting.`,
  },
];

// ---------------------------------------------------------------------------
// Added 2026-07-27. APPEND ONLY — never insert or reorder above this line:
// uploaded files are named thumb-{originalIndex+1}.png, so shifting an index
// renames a concept's slot in every future generation.
//
// The four originals all assume a shouting hero person, which locked out two
// large groups: users who upload no photo at all, and calm/premium/beauty
// content where "surprised face + thick outline" is the wrong language.
// These six were picked from 18 candidates on distinctiveness at phone size,
// coverage of the gaps, and how reliably NBP renders them first try.
// ---------------------------------------------------------------------------
NBP_CONCEPTS.push(
  {
    key: 'object-spotlight',
    lang: 'native',
    label: 'Object spotlight',
    // Deliberately free of expression wording: this is the concept that has to
    // read correctly when the "hero" is a bowl of ramen and no face exists.
    build: (hook, topic, hasFace) =>
      `A high-CTR 16:9 YouTube thumbnail about ${topic}, in a clean product-shot style. ${heroClause(hasFace)}, placed large and centred within the RIGHT half of the frame, lit from the front with clean bright studio light, a crisp rim highlight and a soft contact shadow. One completely flat, boldly saturated single-colour BACKGROUND field filling the whole frame in deep teal, crimson or cobalt, with a soft round glow directly behind the hero (a shape, no lettering), generous empty space, no props, no scenery and no texture. Keep the LEFT half of the frame clear for text. Place the text on the LEFT in a heavy white gothic font with a thick black outline, on one or two lines. ${legible(hook)} ${NO_EXTRA_TEXT} Crisp, premium and impossible to miss.`,
  },
  {
    key: 'calm-authority',
    lang: 'native',
    // The only mirrored layout (hero LEFT, text RIGHT) — that alone makes it
    // distinguishable from everything else in a grid of ten.
    label: 'Calm authority',
    // No thick outline and no serif: at NBP's ~85% CJK fidelity, thin and
    // serif faces are where kana degrades first. The premium read has to come
    // from palette, whitespace and lighting instead.
    build: (hook, topic, hasFace) =>
      `A calm, premium 16:9 YouTube thumbnail about ${topic}, in a restrained editorial style. ${heroClause(hasFace)}, framed calmly and squarely facing the camera, placed large on the LEFT third of the frame with generous empty space around it and even soft directional studio light. Deep muted navy and charcoal BACKGROUND with low saturation, a shallow depth of field and one restrained off-white horizontal accent bar low in the frame (a shape, no lettering) that never touches the hero or the text. Keep the RIGHT half of the frame clear for text. Place the text on the RIGHT in a heavy near-white gothic sans-serif with a very subtle soft shadow and no thick outline, on one or two lines. ${legible(hook)} ${NO_EXTRA_TEXT} Quiet, expert and high-trust.`,
  },
  {
    key: 'split-compare',
    lang: 'native',
    label: 'Before & after',
    // Exactly ONE hero: a second person would be invented by the model and
    // there is only one image_input, so identity would break on the fake one.
    // The "two states" read comes from colour temperature + divider + chevron;
    // VS / BEFORE / AFTER lettering would collide with NO_EXTRA_TEXT, so it
    // belongs in the hook string instead.
    build: (hook, topic, hasFace) =>
      `A high-CTR 16:9 YouTube thumbnail about ${topic}, built as a two-tone split frame with flat graphic-design BACKGROUND blocks only. ${heroClause(hasFace)}, kept PHOTOGRAPHIC and realistic — NOT illustrated, drawn or cartoon — placed large and centred within the RIGHT half of the frame and brightly, warmly lit. The BACKGROUND is divided straight down the middle into two flat, strongly contrasting colour halves, cool and desaturated blue on the LEFT and warm and vivid red-orange on the RIGHT, joined by one bold clean divider band (a shape, no lettering) and one large chevron pointing from the LEFT half toward the hero (a shape, no lettering); neither graphic crosses the hero or the text, and the flat graphic styling applies to the background and shapes, never to the person's face. Keep the LEFT third of the frame clear for text. Place the text on the LEFT in a heavy white-and-yellow gothic font with a thick black outline and a slight skew, on one or two lines. ${legible(hook)} ${NO_EXTRA_TEXT} Bold, punchy and a clear change at a glance.`,
  },
  {
    key: 'risk-warning',
    lang: 'native',
    label: 'Warning',
    // "striped band", never "caution tape" — real tape carries printed words,
    // and naming it re-invites the invented-signage failure NO_EXTRA_TEXT
    // exists to prevent.
    build: (hook, topic, hasFace) =>
      `A high-CTR 16:9 YouTube thumbnail about ${topic} with an urgent warning look. ${heroClause(hasFace)}, placed large in the upper half of the frame slightly to the RIGHT of centre, brightly and evenly lit so it separates cleanly from the dark surroundings. Deep black BACKGROUND with one broad diagonal red and yellow striped band (a shape, no lettering) running behind the hero and one bold red ring with a diagonal slash across it (a shape, no lettering) beside the hero; neither graphic touches the hero or the BOTTOM third. Keep the BOTTOM third of the frame clear for text. Place the text across the BOTTOM in a heavy bright yellow gothic font with a thick black outline, on one or two lines. ${legible(hook)} ${NO_EXTRA_TEXT} Urgent and high-stakes.`,
  },
  {
    key: 'soft-lifestyle',
    lang: 'native',
    label: 'Soft lifestyle',
    // The solid bottom band is the trick that lets a pastel scene keep plain
    // white heavy gothic (the CJK-safe family) at full contrast, instead of
    // forcing a pale or thin face that NBP garbles.
    build: (hook, topic, hasFace) =>
      `A soft, high-CTR 16:9 YouTube thumbnail about ${topic}, in a gentle lifestyle style. ${heroClause(hasFace)}, placed large and centred in the upper two-thirds of the frame, close to the camera, calm and relaxed in feel, clearly lit with soft diffused window light. Creamy pastel BACKGROUND in warm beige, pale rose and soft ivory with a very shallow depth of field so the surroundings melt into out-of-focus soft shapes and gentle bokeh, no props and no scenery detail, plus one solid deep rose-brown horizontal band across the BOTTOM of the frame (a shape, no lettering). Keep the BOTTOM band clear for text. Place the text across the BOTTOM on the solid band in a heavy white gothic font with a subtle shadow, on one or two lines. ${legible(hook)} ${NO_EXTRA_TEXT} Soft, warm and inviting.`,
  },
  {
    key: 'night-cinematic',
    // Second English slot: true-crime / documentary / storytime is a huge
    // global format, and a short Latin hook suits a wide horizontal band.
    lang: 'en',
    label: 'Cinematic night',
    // Front-lit, never a silhouette — that clause is what protects identity in
    // the only dark-and-quiet concept. "top band" stays lowercase: TOP is not
    // one of the validated caps tokens, and a stray all-caps word in the
    // prompt is exactly how a literal "EXACTLY" once got baked onto an image.
    build: (hook, topic, hasFace) =>
      `A cinematic 16:9 YouTube thumbnail about ${topic}, in a quiet storytelling style. ${heroClause(hasFace)}, placed large and centred in the lower two-thirds of the frame, clearly lit from the front by a soft warm key light so it stays bright against the dark surroundings, with no heavy shadow falling across it. Dark, deeply out-of-focus night-blue BACKGROUND with drifting haze, a warm rim light behind the hero, a filmic colour grade and deep shadow falloff toward the upper area of the frame; no buildings, no street furniture and no lit scenery, an empty atmospheric field only. Keep the top band of the frame clear for text. Place the text across the top band in a heavy white gothic font with a subtle shadow, on one or two lines. ${legible(hook)} ${NO_EXTRA_TEXT} Quiet, ominous and cinematic.`,
  }
);

/** Canonical concept keys, in display order. The UI mirrors this list. */
export const NBP_CONCEPT_KEYS: string[] = NBP_CONCEPTS.map((c) => c.key);

// Drift guard. TypeScript catches a *misspelled* key (NbpConcept['key'] is
// ConceptKey), but not a key listed in concept-keys.ts that nobody wrote a
// prompt for — that one would only surface as a picker tile whose generations
// silently never appear. Warn loudly in dev; never throw, because a mismatch
// must not take the production route down.
if (process.env.NODE_ENV !== 'production') {
  const missing = CONCEPT_KEYS.filter((k) => !NBP_CONCEPTS.some((c) => c.key === k));
  const extra = NBP_CONCEPTS.filter((c) => !CONCEPT_KEYS.includes(c.key)).map((c) => c.key);
  if (missing.length || extra.length) {
    console.error(
      `[nbp] concept drift — no prompt for: [${missing.join(', ')}]; not in CONCEPT_KEYS: [${extra.join(', ')}]`
    );
  }
}

/**
 * Resolve client-supplied style keys to the concepts to generate.
 *
 * Each pick keeps its ORIGINAL index in NBP_CONCEPTS, because the caller uses
 * that index to pick a hook and to name the uploaded file. Keeping it stable
 * means a given style always gets the same hook and the same `thumb-N.png`
 * slot no matter what else was selected — so picking one style reproduces the
 * image you'd have gotten from that style in a full run.
 *
 * Unknown keys are ignored rather than rejected (an old client, or a stale
 * tab, shouldn't hard-fail). An explicit list that resolves to nothing returns
 * [], and the route turns that into a 400 — silently generating everything
 * would charge for work nobody asked for.
 *
 * `undefined` means "no preference" → DEFAULT_CONCEPT_KEYS, not everything.
 * Falling back to every concept was safe when a generation cost 1 credit
 * whatever it produced; under per-image credits it would bill a caller that
 * omitted the field for 10 images instead of the 4 it was written against.
 */
export function selectConcepts(raw: unknown): { concept: NbpConcept; index: number }[] {
  const all = NBP_CONCEPTS.map((concept, index) => ({ concept, index }));
  if (raw === undefined || raw === null) {
    return all.filter(({ concept }) => DEFAULT_CONCEPT_KEYS.includes(concept.key));
  }
  if (!Array.isArray(raw)) return [];
  const wanted = new Set(raw.filter((k): k is string => typeof k === 'string'));
  return all.filter(({ concept }) => wanted.has(concept.key));
}

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
