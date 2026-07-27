/**
 * Weekly-refreshed visual guidance appended to the concept prompts.
 *
 * WHY THIS EXISTS AT ALL, AND WHY IT LIVES HERE
 * The previous learning pipeline (scripts/collect-trending-thumbs.ts ->
 * scripts/extract-style-descriptors.ts -> references/descriptors.json) still
 * ran weekly on a cron and still cost money, but NOTHING read its output: the
 * Flux/Satori engine that consumed it was replaced by Nano Banana Pro in the
 * 2026-06-03 pivot and `descriptorClauseFor()` went away with it. A learning
 * loop that isn't wired into generation is just a bill.
 *
 * So this module is deliberately the smallest possible bridge, and the route
 * calls it directly (see app/api/generate/route.ts). If it ever stops being
 * called, the tests around it stop making sense — which is the point.
 *
 * SAFETY OF THE CONTENT
 * The clauses are written by scripts/learn-from-gallery.ts, which looks at
 * third-party thumbnails and is instructed to describe only general visual
 * TENDENCIES (palette, light, contrast, mood) — never a specific image, never
 * layout or typography. Layout is fully specified by each concept prompt and
 * must not be second-guessed here: an appended "put the text on the right"
 * would silently fight the reserved text zone that every prompt depends on.
 * The length cap below is the last line of defence for that.
 */
import rawInsights from '../references/gallery-insights.json';

type GalleryInsights = {
  generated_at: string | null;
  sampled: number;
  observations?: string[];
  byConcept?: Record<string, string>;
};

const insights = rawInsights as GalleryInsights;

// A clause is a nudge, not a rewrite. Anything longer than this is a sign the
// generator drifted into prescribing composition, so it gets dropped rather
// than allowed to overpower a validated prompt.
const MAX_CLAUSE_LENGTH = 200;

/**
 * Extra sentence to append to a concept's prompt, or '' when there is nothing
 * to add. Empty is the normal state before the first weekly run, and the
 * pipeline failing simply means generation keeps using the prompts as written.
 */
export function galleryClauseFor(conceptKey: string): string {
  const clause = insights.byConcept?.[conceptKey];
  if (typeof clause !== 'string') return '';
  const trimmed = clause.trim();
  if (!trimmed || trimmed.length > MAX_CLAUSE_LENGTH) return '';
  return ` ${trimmed}`;
}

/** For diagnostics / the weekly job's own logging. */
export function galleryInsightsMeta(): { generatedAt: string | null; sampled: number; concepts: number } {
  return {
    generatedAt: insights.generated_at,
    sampled: insights.sampled ?? 0,
    concepts: Object.keys(insights.byConcept ?? {}).length,
  };
}
