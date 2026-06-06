import type { createServiceClient } from '@/lib/supabase/server';

type Admin = ReturnType<typeof createServiceClient>;

// PRIVATE bucket for user face photos (personas). Kept separate from the PUBLIC
// `thumbnails` bucket (which holds generated thumbnails that must be publicly
// viewable/downloadable) so a user's uploaded face is NEVER publicly readable.
// The server reaches persona objects only via short-lived signed URLs.
export const PERSONA_BUCKET = 'personas';

// A persona storage key must be exactly `${userId}/<epochMs>-<uuid>.<ext>` —
// this user's namespace only, no traversal, no encoding. Validate a
// client-supplied path against this before signing a URL for it, so a caller can
// never reach another user's or an arbitrary object.
export function isValidPersonaPath(path: string, userId: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 256) return false;
  if (path.includes('..') || path.includes('\\') || path.includes('%')) return false;
  // user.id is a Supabase auth UUID (only [0-9a-f-]), safe to embed in a regex.
  const re = new RegExp(`^${userId}/\\d+-[0-9a-fA-F-]+\\.(png|jpe?g|webp)$`);
  return re.test(path);
}

// Module-level memo so a warm instance ensures the bucket only once.
let bucketEnsured = false;

// Ensure the private personas bucket exists (idempotent + best-effort). A genuine
// failure surfaces when the upload itself fails; we never throw here.
export async function ensurePersonaBucket(admin: Admin): Promise<void> {
  if (bucketEnsured) return;
  try {
    const { data } = await admin.storage.getBucket(PERSONA_BUCKET);
    if (data) {
      bucketEnsured = true;
      return;
    }
    const { error } = await admin.storage.createBucket(PERSONA_BUCKET, { public: false });
    // "already exists" (a concurrent create) is success for our purposes.
    if (!error || /exist/i.test(error.message)) bucketEnsured = true;
    else console.warn('ensurePersonaBucket createBucket:', error.message);
  } catch (e) {
    console.warn('ensurePersonaBucket:', e);
  }
}
