import { NextResponse, type NextRequest } from 'next/server';
import Replicate from 'replicate';
import Anthropic from '@anthropic-ai/sdk';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { generateNbpThumbnail, NBP_CONCEPTS } from '@/lib/nbp';
import { extractVideoId, fetchVideoMetadata } from '@/lib/youtube';
import { isRateLimited } from '@/lib/rate-limit';
import { PERSONA_BUCKET, isValidPersonaPath } from '@/lib/personas';

// 4 parallel Nano Banana Pro calls normally finish in ~40s. Each call has its
// own 90s timeout in lib/nbp, so cap the function at 120s — a hung generation
// fails fast (≈90s) instead of sitting for minutes. Vercel clamps to the plan
// max (60s on Hobby; up to 300s with Fluid Compute / Pro).
export const maxDuration = 120;
export const runtime = 'nodejs';

// CJK / fullwidth / kana ranges. NBP renders CJK well, so unlike the old Flux
// pipeline we do NOT strip CJK from prompts. We only detect it to decide whether
// to translate the scene TOPIC to English (English topics give NBP cleaner,
// more concrete scene grounding), and to scrub the English fields.
const CJK_RANGE = /[　-鿿豈-﫿＀-￯]/g;
function stripCJK(s: string): string {
  return s.replace(CJK_RANGE, ' ').replace(/\s+/g, ' ').trim();
}
function hasCJK(s: string): boolean {
  return /[　-鿿豈-﫿＀-￯]/.test(s);
}

// Plain fallback hook from the title when the LLM is unavailable. NBP renders
// CJK, so we keep the original characters (no stripping) — just trim length.
function fallbackHook(title: string, max: number): string {
  const cleaned = title.replace(/[\[\]【】()（）|｜].*$/, '').trim() || title.trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

// ---- LLM analysis ----------------------------------------------------------
interface EnglishContext {
  title: string;
  channel: string;
  topic: string;
}

interface ThumbAnalysis {
  // English translation of the metadata for NBP's scene description (null = the
  // input was already English or the LLM was unavailable → use originals).
  en: EnglishContext | null;
  // 2-4 word punchy overlay HOOKS, in the title's OWN language (CJK kept).
  hooksNative: string[];
  // The same hooks in ENGLISH — used by the global-localized variants so one
  // URL yields both a JP-optimized and a global-optimized thumbnail.
  hooksEn: string[];
}

// One Haiku call returns: (1) an English translation for scene grounding, (2)
// short punchy HOOKS in the title's own language, and (3) the same hooks in
// English. Degrades gracefully so generation never breaks.
async function analyzeForThumbnail(
  title: string,
  channel: string,
  description: string
): Promise<ThumbAnalysis> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY not set — no hooks/translation, using title fallback');
    return { en: null, hooksNative: [], hooksEn: [] };
  }
  const needsTranslation = hasCJK(title) || hasCJK(channel) || hasCJK(description);
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create(
      {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: `You are a YouTube thumbnail expert. From this video metadata, produce JSON with three things:
(1) "translation": clean ENGLISH for an AI image-generation prompt — {"title": <max 12 words>, "channel": <max 6 words>, "topic": <one visual sentence describing the video's subject/scene, max 20 words>}. Concise, visual, concrete nouns.
(2) "hooks_native": array of 4 SHORT thumbnail hook phrases in the SAME LANGUAGE as the Title (max 8 characters if Japanese, max 4 words if English). Punchy curiosity/stakes/emotion copy — NOT the literal title. e.g. "まさかの結末","新記録","1日で激変","衝撃の真実".
(3) "hooks_en": the SAME 4 hooks written in natural punchy ENGLISH (max 4 words each). e.g. "GONE WRONG","I QUIT","$0 to $1M","NEW RECORD".

Title: ${title}
Channel: ${channel}
Description (first 400 chars): ${(description || '').slice(0, 400)}

Reply with ONLY this JSON, no preamble, no code fences:
{"translation":{"title":"...","channel":"...","topic":"..."},"hooks_native":["...","...","...","..."],"hooks_en":["...","...","...","..."]}`,
        },
      ],
      },
      { timeout: 15_000 }
    );
    const text = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object in LLM response');
    const parsed = JSON.parse(jsonMatch[0]);
    const t = parsed.translation || {};
    const en: EnglishContext | null = needsTranslation
      ? {
          title: stripCJK(String(t.title || '')).slice(0, 120),
          channel: stripCJK(String(t.channel || '')).slice(0, 60),
          topic: stripCJK(String(t.topic || '')).slice(0, 240),
        }
      : null;
    const clean = (arr: unknown, max: number): string[] =>
      Array.isArray(arr)
        ? arr
            .map((h: unknown) => String(h ?? '').trim())
            .filter((h: string) => h.length > 0 && h.length <= max)
            .slice(0, 4)
        : [];
    return {
      en,
      hooksNative: clean(parsed.hooks_native, 40),
      hooksEn: clean(parsed.hooks_en, 40),
    };
  } catch (err) {
    console.warn('LLM analysis failed (falling back to title):', err);
    return { en: null, hooksNative: [], hooksEn: [] };
  }
}

async function uploadPng(
  buffer: Buffer,
  userId: string,
  generationId: string,
  filename: string
): Promise<string> {
  const path = `${userId}/${generationId}/${filename}.png`;
  const admin = createServiceClient();
  const { error } = await admin.storage
    .from('thumbnails')
    .upload(path, buffer, { contentType: 'image/png', upsert: true });
  if (error) throw error;
  const { data } = admin.storage.from('thumbnails').getPublicUrl(path);
  return data.publicUrl;
}

type Reservation =
  | { ok: true; plan: string; limit: number; usedBefore: number }
  | { ok: false; status: 402 | 429 | 500; plan?: string; limit?: number };

// Atomically reserve ONE generation slot BEFORE any paid NBP work. The old flow
// read generations_used, checked the limit, did ~40s of paid work, then blindly
// wrote `used + 1` from the stale snapshot — so N concurrent requests all passed
// the check and each ran 4 × $0.134 NBP images (a TOCTOU money leak), and the
// races also lost-update the counter. Compare-and-set (update guarded by the
// value we just read) serializes concurrent callers: only `limit` of them can
// ever claim a slot, and we never persist a stale value.
async function reserveGenerationSlot(
  admin: ReturnType<typeof createServiceClient>,
  userId: string
): Promise<Reservation> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data: profile, error } = await admin
      .from('profiles')
      .select('plan, generations_used, generations_limit')
      .eq('id', userId)
      .single();
    if (error || !profile) return { ok: false, status: 500 };
    const used = profile.generations_used as number;
    const limit = profile.generations_limit as number;
    if (used >= limit) return { ok: false, status: 402, plan: profile.plan as string, limit };
    // CAS: claim the slot only if nobody moved generations_used since we read it.
    // .select() returns the row ONLY when the guarded WHERE matched.
    const { data: claimed, error: casErr } = await admin
      .from('profiles')
      .update({ generations_used: used + 1 })
      .eq('id', userId)
      .eq('generations_used', used)
      .select('id');
    if (casErr) return { ok: false, status: 500 };
    if (claimed && claimed.length === 1) {
      return { ok: true, plan: profile.plan as string, limit, usedBefore: used };
    }
    // Lost the race to a concurrent request — re-read and try again.
  }
  return { ok: false, status: 429 };
}

// Give a reserved slot back (best effort) when a generation produced nothing, so
// a transient total failure doesn't burn the user's quota. Guarded CAS so it can
// never over-credit under concurrency; never throws.
async function refundGenerationSlot(
  admin: ReturnType<typeof createServiceClient>,
  userId: string
): Promise<void> {
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data: profile, error } = await admin
        .from('profiles')
        .select('generations_used')
        .eq('id', userId)
        .single();
      if (error || !profile) return;
      const used = profile.generations_used as number;
      if (used <= 0) return;
      const { data: claimed } = await admin
        .from('profiles')
        .update({ generations_used: used - 1 })
        .eq('id', userId)
        .eq('generations_used', used)
        .select('id');
      if (claimed && claimed.length === 1) return;
    }
  } catch (e) {
    console.warn('refundGenerationSlot failed (non-fatal):', e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const youtubeUrl =
      typeof body.youtube_url === 'string' ? body.youtube_url.trim().slice(0, 2048) : '';
    // Face hero comes ONLY from the user's own uploaded photo (persona) — never
    // a third party's. The video URL is used for topic/hooks only. Without a
    // persona, NBP generates a faceless topical scene (legally safe). The client
    // sends the storage PATH (not a URL); we re-sign a short-lived URL below.
    const personaPath = typeof body.persona_path === 'string' ? body.persona_path.trim() : '';
    const customTextRaw =
      typeof body.custom_text === 'string' ? body.custom_text.trim() : '';
    const customText = customTextRaw.slice(0, 60);
    if (!youtubeUrl) {
      return NextResponse.json({ error: 'youtube_url is required', code: 'empty' }, { status: 400 });
    }

    // SECURITY / CONSENT: only accept a persona PATH inside THIS user's own
    // namespace in the private personas bucket. The UI gets this path from
    // /api/upload-persona (which face-validates, records consent, and stores it).
    // A direct API caller could otherwise pass an arbitrary path — e.g. another
    // user's object — so validate strictly (no traversal/encoding/other
    // namespace) BEFORE we sign a URL for it. We never accept a client URL, so
    // there is no URL to be tricked by; we re-sign server-side from the path.
    if (personaPath && !isValidPersonaPath(personaPath, user.id)) {
      return NextResponse.json({ error: 'Invalid persona image', code: 'persona_invalid' }, { status: 400 });
    }

    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) {
      return NextResponse.json({ error: 'Invalid YouTube URL', code: 'invalid_url' }, { status: 400 });
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('plan, generations_used, generations_limit')
      .eq('id', user.id)
      .single();
    if (profileError || !profile) {
      return NextResponse.json({ error: 'Profile not found', code: 'server' }, { status: 500 });
    }
    if (profile.generations_used >= profile.generations_limit) {
      return NextResponse.json(
        {
          error: 'Generation limit reached',
          plan: profile.plan,
          limit: profile.generations_limit,
        },
        { status: 402 }
      );
    }

    const admin = createServiceClient();

    // Abuse brake (no extra infra): cap generation ATTEMPTS per user/hour, BEFORE
    // any paid metadata/Haiku/NBP work. The quota alone doesn't cap spend because
    // a failed generation refunds its slot — so an attacker could force failures
    // and burn paid NBP work indefinitely; this bounds that.
    if (
      await isRateLimited(admin, {
        table: 'generations',
        userId: user.id,
        windowMs: 3_600_000,
        max: 20,
      })
    ) {
      return NextResponse.json(
        { error: 'Too many generations recently. Please try again later.', code: 'rate_limited' },
        { status: 429 }
      );
    }

    const meta = await fetchVideoMetadata(videoId);
    const { en, hooksNative, hooksEn } = await analyzeForThumbnail(
      meta.title,
      meta.channelTitle,
      meta.description
    );
    // Scene topic for NBP: prefer the English translation (cleaner grounding),
    // else the raw title (NBP handles CJK fine).
    const topic = en?.topic || meta.title;
    const fbNative = fallbackHook(meta.title, 12);
    const fbEn = (en?.title || meta.title).slice(0, 24);

    // Identity reference = a FRESH short-lived signed URL for the user's own
    // persona in the PRIVATE bucket — re-signed here so it can't expire between
    // upload and generate and the object is never public. NBP (Replicate) fetches
    // it within the TTL. A faceless request (no persona) skips this entirely.
    let faceRefUrls: string[] = [];
    if (personaPath) {
      const { data: signed, error: signErr } = await admin.storage
        .from(PERSONA_BUCKET)
        .createSignedUrl(personaPath, 600);
      if (signErr || !signed?.signedUrl) {
        console.error('persona sign failed:', signErr);
        return NextResponse.json(
          { error: 'Could not load your uploaded photo. Please re-upload and try again.', code: 'persona_load' },
          { status: 400 }
        );
      }
      faceRefUrls = [signed.signedUrl];
    }
    const hasFace = faceRefUrls.length > 0;

    // Per-concept hook: user's custom overlay wins; else an LLM hook in the
    // concept's language (native vs English); else the title fallback.
    const hookFor = (concept: (typeof NBP_CONCEPTS)[number], i: number): string => {
      if (customText) return customText;
      if (concept.lang === 'en') return hooksEn[i % Math.max(1, hooksEn.length)] || fbEn;
      return hooksNative[i % Math.max(1, hooksNative.length)] || fbNative;
    };
    const prompts = NBP_CONCEPTS.map((c, i) => c.build(hookFor(c, i), topic, hasFace));

    // Atomically charge the quota slot now, immediately before the paid NBP work
    // (after the cheap metadata/Haiku calls so an invalid URL never costs a slot).
    // This is the real gate — the early read above is just a fast reject.
    const reservation = await reserveGenerationSlot(admin, user.id);
    if (!reservation.ok) {
      if (reservation.status === 402) {
        return NextResponse.json(
          { error: 'Generation limit reached', plan: reservation.plan, limit: reservation.limit },
          { status: 402 }
        );
      }
      if (reservation.status === 429) {
        return NextResponse.json(
          { error: 'Too many requests in flight, please retry.' },
          { status: 429 }
        );
      }
      return NextResponse.json({ error: 'Could not start generation', code: 'server' }, { status: 500 });
    }
    const generationsUsedAfter = reservation.usedBefore + 1;

    const { data: insertRow, error: insertError } = await admin
      .from('generations')
      .insert({
        user_id: user.id,
        youtube_url: youtubeUrl,
        youtube_video_id: videoId,
        video_title: meta.title,
        video_description: meta.description.slice(0, 1000),
        channel_title: meta.channelTitle,
        prompts,
        status: 'processing',
      })
      .select('id')
      .single();
    if (insertError || !insertRow) {
      await refundGenerationSlot(admin, user.id); // nothing generated yet
      return NextResponse.json({ error: 'Failed to record generation', code: 'server' }, { status: 500 });
    }
    const generationId = insertRow.id as string;

    let thumbs: { url: string; conceptKey: string; label: string }[];
    try {
      const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
      // Generate + upload every concept in parallel, but tolerate INDIVIDUAL
      // failures (NBP safety filter, transient errors): one bad concept must not
      // sink the whole generation — we keep whatever succeeded.
      const settled = await Promise.allSettled(
        NBP_CONCEPTS.map(async (concept, i) => {
          const buf = await generateNbpThumbnail({ replicate, prompt: prompts[i], faceRefUrls });
          const url = await uploadPng(buf, user.id, generationId, `thumb-${i + 1}`);
          return { url, conceptKey: concept.key, label: concept.label };
        })
      );
      thumbs = settled.flatMap((r, i) => {
        if (r.status === 'fulfilled') return [r.value];
        console.warn(`NBP concept ${NBP_CONCEPTS[i].key} failed:`, r.reason);
        return [];
      });
      if (thumbs.length === 0) throw new Error('All thumbnail generations failed');
    } catch (genError) {
      await admin
        .from('generations')
        .update({
          status: 'failed',
          error_message:
            genError instanceof Error ? genError.message : 'Generation failed',
        })
        .eq('id', generationId);
      // Nothing was produced — give the reserved slot back so a transient failure
      // doesn't cost the user a generation.
      await refundGenerationSlot(admin, user.id);
      console.error('generate: all concepts failed', genError);
      return NextResponse.json({ error: 'Generation failed, please try again.', code: 'gen_failed' }, { status: 500 });
    }

    // Quota was already charged at reservation time, so no increment here.
    const { error: completeErr } = await admin
      .from('generations')
      .update({ status: 'completed', thumbnail_urls: thumbs.map((t) => t.url) })
      .eq('id', generationId);
    if (completeErr) console.error('generate: failed to mark completed', generationId, completeErr);

    const { error: logErr } = await admin.from('usage_logs').insert({
      user_id: user.id,
      event_type: 'generation_completed',
      metadata: {
        video_id: videoId,
        title: meta.title,
        engine: 'nano-banana-pro',
        has_face: hasFace,
        custom_text: customText || null,
      },
    });
    if (logErr) console.error('generate: failed to write usage log', logErr);

    return NextResponse.json({
      id: generationId,
      thumbnails: thumbs.map((t, i) => ({
        id: i + 1,
        url: t.url,
        // NBP output is the finished artifact — there is no separate text-free
        // "raw" layer, so image_url mirrors url.
        image_url: t.url,
        concept_key: t.conceptKey,
        prompt: t.label,
      })),
      generations_used: generationsUsedAfter,
      generations_limit: reservation.limit,
    });
  } catch (err) {
    console.error('API /generate error', err);
    // "Video not found or private" is a useful, secret-free signal for the user;
    // everything else stays generic so internal/upstream detail never leaks.
    const m = err instanceof Error ? err.message : '';
    if (m === 'Video not found or private') {
      return NextResponse.json({ error: m, code: 'video_not_found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'Something went wrong, please try again.', code: 'server' }, { status: 500 });
  }
}
