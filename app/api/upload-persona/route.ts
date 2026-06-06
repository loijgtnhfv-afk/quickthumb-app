import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isRateLimited } from '@/lib/rate-limit';
import { PERSONA_BUCKET, ensurePersonaBucket } from '@/lib/personas';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Vercel Serverless Functions reject request bodies over ~4.5MB at the platform
// edge (an opaque 413) before our handler runs, so cap below that to return a
// clear, localizable error instead of the platform's generic failure.
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED = ['image/png', 'image/jpeg', 'image/webp'];

// Validate the uploaded image actually shows ONE clear human face before we keep
// it, so a user doesn't upload a logo / landscape / group photo and then get
// poor or confusing results. One cheap Claude Haiku vision call (~$0.001).
// FAIL-OPEN: any error, missing key, or low confidence ACCEPTS the upload — we
// never block on our own failure; we only reject a confident no-face / multi-face.
async function faceCheck(buf: Buffer): Promise<{ reject: boolean; reason?: string }> {
  if (!process.env.ANTHROPIC_API_KEY) return { reject: false };
  try {
    const small = await sharp(buf)
      .rotate()
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: small.toString('base64') },
            },
            {
              type: 'text',
              text: `Does this image contain exactly ONE clear, real human face usable as a thumbnail hero? Judge ONLY the presence and COUNT of human faces — never identity. Reply with ONLY this JSON, no prose: {"face_count": <integer>, "confidence": <0..1>}`,
            },
          ],
        },
      ],
    });
    const text = msg.content[0]?.type === 'text' ? msg.content[0].text : '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { reject: false };
    const parsed = JSON.parse(m[0]);
    const count = Number(parsed.face_count);
    const conf = Number(parsed.confidence);
    // Only reject when the model is reasonably sure; otherwise let it through.
    if (!Number.isFinite(count) || !Number.isFinite(conf) || conf < 0.7) return { reject: false };
    if (count === 0) return { reject: true, reason: 'no_face' };
    if (count >= 2) return { reject: true, reason: 'multiple_faces' };
    return { reject: false };
  } catch (e) {
    console.warn('faceCheck failed (accepting upload):', e);
    return { reject: false };
  }
}

// Upload the user's OWN face photo ("persona"). It becomes the identity
// reference fed to Nano Banana Pro, so the generated face is the user's own
// (consent) rather than a third party's. Stored in the PRIVATE `personas`
// bucket; Replicate fetches it via a short-lived signed URL minted at
// generation time (the object is never publicly readable).
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    }
    // Likeness-consent gate (defense-in-depth behind the UI checkbox): a face
    // photo may only be uploaded with an explicit "this is my own face / I have
    // the right to use it" attestation. A direct API caller must assert it too;
    // we record the attestation below. Right-of-publicity has no safe harbor, so
    // the consent must be affirmative, not implied.
    if (form?.get('consent') !== 'true') {
      return NextResponse.json(
        { error: 'Consent is required to upload a face photo.', code: 'consent' },
        { status: 400 }
      );
    }
    if (!ALLOWED.includes(file.type)) {
      return NextResponse.json({ error: 'Use a PNG, JPG or WebP image' }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'Image too large (max 4MB)', code: 'too_large' }, { status: 400 });
    }

    const admin = createServiceClient();
    // Abuse brake (no extra infra): cap successful uploads per user/hour, before
    // the paid vision call + storage write, to bound storage growth / cost.
    if (
      await isRateLimited(admin, {
        table: 'usage_logs',
        userId: user.id,
        windowMs: 3_600_000,
        max: 20,
        eventType: 'persona_consent',
      })
    ) {
      return NextResponse.json(
        { error: 'Too many uploads recently. Please try again later.', code: 'rate_limited' },
        { status: 429 }
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());

    const check = await faceCheck(buf);
    if (check.reject) {
      return NextResponse.json(
        { error: 'No single clear face found in the photo.', code: 'face_check', reason: check.reason },
        { status: 422 }
      );
    }

    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
    // Timestamped (+random) key in the user's namespace. The leading epoch-ms is
    // parsed by the cleanup below to delete only strictly-older personas.
    const ts = Date.now();
    const path = `${user.id}/${ts}-${randomUUID()}.${ext}`;

    // Store in the PRIVATE personas bucket (never the public thumbnails bucket) so
    // the user's face photo is not publicly readable. Created on demand.
    await ensurePersonaBucket(admin);
    const { error } = await admin.storage
      .from(PERSONA_BUCKET)
      .upload(path, buf, { contentType: file.type, upsert: true });
    if (error) {
      // Log the raw storage error server-side only; return a generic message.
      console.error('persona upload storage error:', error);
      return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 500 });
    }
    // Short-lived signed URL for the client to PREVIEW the upload (the object is
    // private). Generation re-signs a fresh URL from the returned `path`, so a
    // preview expiring never affects generation.
    const { data: signed } = await admin.storage
      .from(PERSONA_BUCKET)
      .createSignedUrl(path, 3600);

    // Record the likeness-consent attestation (audit trail for right-of-publicity:
    // who consented, when, from where). Best-effort — never block the upload on a
    // logging failure.
    try {
      const ip =
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip') ||
        null;
      const { error: logErr } = await admin.from('usage_logs').insert({
        user_id: user.id,
        event_type: 'persona_consent',
        metadata: {
          consent: true,
          path,
          ip,
          user_agent: request.headers.get('user-agent') || null,
          at: new Date().toISOString(),
        },
      });
      // Surface a DB-level failure (supabase-js returns it, doesn't throw) so a
      // broken consent audit trail is observable; still never block the upload.
      if (logErr) console.warn('persona consent log failed (non-fatal):', logErr);
    } catch (e) {
      console.warn('persona consent log failed (non-fatal):', e);
    }

    // Bound storage growth: keep only the just-uploaded persona; delete older ones
    // (every re-upload otherwise leaves a new timestamped object forever).
    try {
      const { data: existing } = await admin.storage
        .from(PERSONA_BUCKET)
        .list(user.id, { limit: 100 });
      // Delete only personas STRICTLY OLDER than this upload (compare the leading
      // epoch-ms in the name). Never remove a same-or-newer object, so a
      // concurrent same-user upload can't have its just-returned file deleted out
      // from under it. `o.id` skips folder placeholders the API can return.
      const stale = (existing || [])
        .filter((o) => o.id)
        .filter((o) => {
          const ots = parseInt(o.name, 10);
          return Number.isFinite(ots) && ots < ts;
        })
        .map((o) => `${user.id}/${o.name}`);
      if (stale.length) await admin.storage.from(PERSONA_BUCKET).remove(stale);
    } catch (e) {
      console.warn('persona cleanup failed (non-fatal):', e);
    }

    // `path` is the stable identifier the client passes to /api/generate (which
    // re-signs it); `url` is only for the in-session preview.
    return NextResponse.json({ url: signed?.signedUrl ?? null, path });
  } catch (err) {
    console.error('upload-persona error', err);
    return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 500 });
  }
}
