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
] as const;

export type ConceptKey = (typeof CONCEPT_KEYS)[number];

/** Widened copy for the many places that just need `string[]`. */
export const ALL_CONCEPT_KEYS: string[] = [...CONCEPT_KEYS];
