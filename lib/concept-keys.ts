/**
 * The canonical list of thumbnail style keys, in generation order.
 *
 * This lives in its own dependency-free module because BOTH sides need it:
 * `lib/nbp.ts` (server, pulls in the Replicate SDK) attaches a prompt builder
 * to each key, and `app/page.tsx` (client) renders a picker for them. Importing
 * nbp.ts from the client component to get the keys would drag Replicate into
 * the browser bundle, and hand-copying the list into page.tsx would let the two
 * drift silently — a key present in only one place is either a style nobody can
 * pick or a picker tile that 400s.
 *
 * APPEND ONLY. Generated files are named thumb-{index+1}.png from a concept's
 * position here, so inserting or reordering renames existing slots.
 */
export const CONCEPT_KEYS = [
  'face-surprise',
  'jp-telop',
  'global-clean',
  'action',
  'object-spotlight',
  'calm-authority',
  'split-compare',
  'risk-warning',
  'soft-lifestyle',
  'night-cinematic',
  'anime-style',
  'game-live',
] as const;

export type ConceptKey = (typeof CONCEPT_KEYS)[number];

/** Widened copy for the many places that just need `string[]`. */
export const ALL_CONCEPT_KEYS: string[] = [...CONCEPT_KEYS];

/**
 * What a request gets when it does not say which styles it wants.
 *
 * These four are the set that existed before the picker, and — now that one
 * credit means one image — they are also what a caller expects to pay. The
 * server used to fall back to EVERY concept for compatibility with older
 * clients, which was harmless when a generation cost 1 regardless of image
 * count. With per-image credits that same fallback silently charges 10 instead
 * of 4: a browser tab opened before the deploy still posts `{youtube_url}` with
 * no `concept_keys`, and the user is billed 2.5x for images they never asked
 * for. Defaulting to the historical four keeps the cost identical to what that
 * client was built against.
 */
export const DEFAULT_CONCEPT_KEYS: string[] = [
  'face-surprise',
  'jp-telop',
  'global-clean',
  'action',
];
