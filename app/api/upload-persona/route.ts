import { NextResponse, type NextRequest } from 'next/server';
import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_BYTES = 8 * 1024 * 1024;
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
// (consent) rather than a third party's. Stored in the public `thumbnails`
// bucket so Replicate can fetch it as an image_input URL.
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
    if (!ALLOWED.includes(file.type)) {
      return NextResponse.json({ error: 'Use a PNG, JPG or WebP image' }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'Image too large (max 8MB)' }, { status: 400 });
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
    // Timestamped path so a re-upload busts the CDN cache for the public URL.
    const path = `${user.id}/persona/${Date.now()}.${ext}`;

    const admin = createServiceClient();
    const { error } = await admin.storage
      .from('thumbnails')
      .upload(path, buf, { contentType: file.type, upsert: true });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const { data } = admin.storage.from('thumbnails').getPublicUrl(path);
    return NextResponse.json({ url: data.publicUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
