import { NextResponse, type NextRequest } from 'next/server';
import Replicate from 'replicate';
import Anthropic from '@anthropic-ai/sdk';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { generateNbpThumbnail, NBP_CONCEPTS, selectConcepts } from '@/lib/nbp';
import { galleryClauseFor } from '@/lib/gallery-insights';
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
  description: string,
  // One hook per thumbnail being generated. Asking for a fixed 4 while the
  // user can now pick up to NBP_CONCEPTS.length styles would make the extra
  // styles reuse hooks 0..3 — several thumbnails carrying identical wording,
  // which reads as broken rather than as variety.
  hookCount: number
): Promise<ThumbAnalysis> {
  const want = Math.max(1, Math.min(hookCount, NBP_CONCEPTS.length));
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
      // Scales with `want` (up to NBP_CONCEPTS.length hooks in two languages);
      // 500 was sized for exactly 4 and truncates the JSON past ~6.
      max_tokens: 300 + want * 70,
      messages: [
        {
          role: 'user',
          content: `You are a YouTube thumbnail expert. From this video metadata, produce JSON with three things:
(1) "translation": clean ENGLISH for an AI image-generation prompt — {"title": <max 12 words>, "channel": <max 6 words>, "topic": <one visual sentence describing the video's subject/scene, max 20 words>}. Concise, visual, concrete nouns.
(2) "hooks_native": array of ${want} SHORT thumbnail hook phrases in the SAME LANGUAGE as the Title (max 8 characters if Japanese, max 4 words if English). Punchy curiosity/stakes/emotion copy — NOT the literal title. e.g. "まさかの結末","新記録","1日で激変","衝撃の真実". Make all ${want} DIFFERENT from each other — vary the angle (curiosity, stakes, result, warning, emotion), never restate one phrase.
(3) "hooks_en": the SAME ${want} hooks written in natural punchy ENGLISH (max 4 words each). e.g. "GONE WRONG","I QUIT","$0 to $1M","NEW RECORD".

Title: ${title}
Channel: ${channel}
Description (first 400 chars): ${(description || '').slice(0, 400)}

Reply with ONLY this JSON, no preamble, no code fences (each hooks array must hold exactly ${want} items):
{"translation":{"title":"...","channel":"...","topic":"..."},"hooks_native":[${Array(want).fill('"..."').join(',')}],"hooks_en":[${Array(want).fill('"..."').join(',')}]}`,
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
        ? // Dedupe: the model occasionally repeats a phrase when asked for many
          // hooks, and two thumbnails with the same words is the exact failure
          // asking for `want` hooks was meant to avoid.
          [
            ...new Set(
              arr
                .map((h: unknown) => String(h ?? '').trim())
                .filter((h: string) => h.length > 0 && h.length <= max)
            ),
          ].slice(0, want)
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
  | { ok: true; plan: string; limit: number; usedBefore: number; charged: number }
  | {
      ok: false;
      status: 402 | 429 | 500;
      plan?: string;
      limit?: number;
      used?: number;
      remaining?: number;
    };

// Atomically reserve `want` IMAGE CREDITS before any paid NBP work. The quota
// unit is one generated image: picking 1 of the styles costs 1, picking all of
// them costs NBP_CONCEPTS.length.
//
// The old flow read the counter, checked the limit, did ~40s of paid work, then
// blindly wrote back from the stale snapshot — so N concurrent requests all
// passed the check and each ran paid NBP images (a TOCTOU money leak), and the
// races also lost-update the counter. Per-image credits only sharpen that: a
// stale read now leaks up to NBP_CONCEPTS.length credits per racing request
// instead of 1. Compare-and-set (update guarded by the value we just read)
// serializes concurrent callers: they can never oversell `limit`, and we never
// persist a stale value.
//
// KNOWN GAP (accepted, revisit before Stripe goes live): a reservation is a
// counter bump, not a row. If the Stripe webhook resets image_credits_used to 0
// for a renewal WHILE a generation is in flight, that generation's charge
// vanishes with the old cycle and the images effectively land free against the
// new one. Closing it properly needs a reservations table (or a period stamp
// compared at completion); the error is bounded by one generation, only fires
// in the seconds around a renewal event, and errs toward the user, so it is not
// worth that machinery while billing is still inert. usage_logs records
// images_charged/credits_after per generation, so it stays auditable.
async function reserveImageCredits(
  admin: ReturnType<typeof createServiceClient>,
  userId: string,
  want: number
): Promise<Reservation> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data: profile, error } = await admin
      .from('profiles')
      .select('plan, image_credits_used, image_credits_limit')
      .eq('id', userId)
      .single();
    if (error || !profile) return { ok: false, status: 500 };
    const used = profile.image_credits_used as number;
    const limit = profile.image_credits_limit as number;
    // Affordability is re-tested on EVERY re-read, not once before the loop: a
    // concurrent request may have taken the headroom we saw. Partial fulfilment
    // is deliberately not offered — silently trimming a 4-style request down to
    // the 2 they can afford would deliver something they didn't ask for.
    if (used + want > limit) {
      return {
        ok: false,
        status: 402,
        plan: profile.plan as string,
        limit,
        used,
        remaining: Math.max(0, limit - used),
      };
    }
    // CAS: claim only if NEITHER the counter nor the ceiling moved since we
    // read them. Guarding the counter alone leaves a hole: the affordability
    // test above used the limit we read, so a Stripe downgrade landing between
    // the read and this update would let the claim through against the old,
    // higher limit and oversell the new one. Including it in the WHERE makes
    // that case lose the race and re-evaluate against the new limit instead.
    const { data: claimed, error: casErr } = await admin
      .from('profiles')
      .update({ image_credits_used: used + want })
      .eq('id', userId)
      .eq('image_credits_used', used)
      .eq('image_credits_limit', limit)
      .select('id');
    if (casErr) return { ok: false, status: 500 };
    if (claimed && claimed.length === 1) {
      return { ok: true, plan: profile.plan as string, limit, usedBefore: used, charged: want };
    }
    // Lost the race to a concurrent request — re-read and try again.
  }
  return { ok: false, status: 429 };
}

// Give `n` reserved credits back (best effort) for images that were charged but
// never delivered — a total failure, or the 1 missing image when 4 were asked
// for and 3 came back. Guarded CAS so it can never over-credit under
// concurrency, clamped at 0 so a concurrent Stripe renewal reset can't push the
// counter negative; never throws.
async function refundImageCredits(
  admin: ReturnType<typeof createServiceClient>,
  userId: string,
  n: number
): Promise<void> {
  if (n <= 0) return;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data: profile, error } = await admin
        .from('profiles')
        .select('image_credits_used')
        .eq('id', userId)
        .single();
      if (error || !profile) return;
      const used = profile.image_credits_used as number;
      if (used <= 0) return;
      const { data: claimed } = await admin
        .from('profiles')
        .update({ image_credits_used: Math.max(0, used - n) })
        .eq('id', userId)
        .eq('image_credits_used', used)
        .select('id');
      if (claimed && claimed.length === 1) return;
    }
  } catch (e) {
    console.warn('refundImageCredits failed (non-fatal):', e);
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

    // Which styles to generate. Omitting the field keeps the old behaviour
    // (all four); sending a list that matches nothing is a client bug worth
    // surfacing rather than silently generating — and billing — all four.
    const selected = selectConcepts(body.concept_keys);
    if (selected.length === 0) {
      return NextResponse.json(
        { error: 'Select at least one style', code: 'no_styles' },
        { status: 400 }
      );
    }
    // One image = one credit, so the style count IS the price of this request.
    const wantedImages = selected.length;

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
      .select('plan, image_credits_used, image_credits_limit')
      .eq('id', user.id)
      .single();
    if (profileError || !profile) {
      return NextResponse.json({ error: 'Profile not found', code: 'server' }, { status: 500 });
    }
    // Fast reject before the paid metadata/Haiku calls. The authoritative check
    // is the atomic reservation further down; this one just avoids spending on a
    // request that plainly can't be afforded.
    const remainingNow = Math.max(0, profile.image_credits_limit - profile.image_credits_used);
    if (remainingNow < wantedImages) {
      return NextResponse.json(
        {
          error: 'Not enough image credits',
          code: remainingNow === 0 ? 'out_of_credits' : 'insufficient_credits',
          plan: profile.plan,
          limit: profile.image_credits_limit,
          used: profile.image_credits_used,
          remaining: remainingNow,
          requested: wantedImages,
        },
        { status: 402 }
      );
    }

    const admin = createServiceClient();

    // Abuse brake (no extra infra): cap generation ATTEMPTS per user/hour, BEFORE
    // any paid metadata/Haiku/NBP work. Credits alone don't cap spend because
    // failed images are refunded — so an attacker could force failures and burn
    // paid NBP work indefinitely; this bounds that.
    //
    // The cap counts attempts, not images, so per-image credits made each
    // attempt worth up to NBP_CONCEPTS.length images instead of 4 — the worst
    // case behind this brake grew ~2.5x. Lowered 20 -> 12 to hold the ceiling
    // roughly where it was (12 x 10 x $0.134 ≈ $16/hour/user, and only for a
    // user deliberately forcing failures).
    if (
      await isRateLimited(admin, {
        table: 'generations',
        userId: user.id,
        windowMs: 3_600_000,
        max: 12,
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
      meta.description,
      selected.length
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
    // Hook index counts within THIS selection, so N picked styles consume
    // hooks 0..N-1 and every thumbnail in the batch carries different wording.
    // (Indexing by the concept's original position instead would leave holes —
    // picking styles 0, 5 and 9 out of 10 would read hooks 5 and 9 from a
    // 3-item array and fall back to the same title text twice.)
    // The gallery clause is appended, never interpolated into the concept's own
    // wording: the layout, text zone and anti-invented-text rules in that string
    // are validated, and a weekly-refreshed sentence must be able to tint the
    // look without being able to move the text.
    const prompts = selected.map(({ concept }, i) =>
      concept.build(hookFor(concept, i), topic, hasFace) + galleryClauseFor(concept.key)
    );

    // Atomically charge one credit per requested image now, immediately before
    // the paid NBP work (after the cheap metadata/Haiku calls so an invalid URL
    // never costs credits). This is the real gate — the early read above is just
    // a fast reject.
    const reservation = await reserveImageCredits(admin, user.id, wantedImages);
    if (!reservation.ok) {
      if (reservation.status === 402) {
        return NextResponse.json(
          {
            error: 'Not enough image credits',
            code: reservation.remaining === 0 ? 'out_of_credits' : 'insufficient_credits',
            plan: reservation.plan,
            limit: reservation.limit,
            used: reservation.used,
            remaining: reservation.remaining,
            requested: wantedImages,
          },
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
    // Mutable: every undelivered image is refunded below and subtracted here, so
    // the number the client renders matches what was actually charged.
    let creditsUsedAfter = reservation.usedBefore + reservation.charged;

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
      await refundImageCredits(admin, user.id, reservation.charged); // nothing generated yet
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
        selected.map(async ({ concept, index }, i) => {
          const buf = await generateNbpThumbnail({ replicate, prompt: prompts[i], faceRefUrls });
          // Name by the concept's original slot, not the position within this
          // selection, so file names stay meaningful across partial runs.
          const url = await uploadPng(buf, user.id, generationId, `thumb-${index + 1}`);
          return { url, conceptKey: concept.key, label: concept.label };
        })
      );
      thumbs = settled.flatMap((r, i) => {
        if (r.status === 'fulfilled') return [r.value];
        console.warn(`NBP concept ${selected[i].concept.key} failed:`, r.reason);
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
      // Nothing was produced — give the whole reservation back so a transient
      // failure doesn't cost the user anything.
      await refundImageCredits(admin, user.id, reservation.charged);
      console.error('generate: all concepts failed', genError);
      return NextResponse.json({ error: 'Generation failed, please try again.', code: 'gen_failed' }, { status: 500 });
    }

    // PARTIAL failure: charged for `charged` images, delivered `thumbs.length`.
    // Refund the difference. Reached only when at least one image survived —
    // the zero case throws above and refunds the full reservation, so the two
    // paths can never both fire.
    const undelivered = reservation.charged - thumbs.length;
    if (undelivered > 0) {
      await refundImageCredits(admin, user.id, undelivered);
      // Re-read rather than subtract locally: a refund is a compare-and-set
      // that can lose its race, and a concurrent request (or a Stripe renewal
      // resetting the counter) moves the balance underneath us either way.
      // Guessing here is what makes the header disagree with the database.
      const { data: fresh } = await admin
        .from('profiles')
        .select('image_credits_used')
        .eq('id', user.id)
        .single();
      creditsUsedAfter =
        typeof fresh?.image_credits_used === 'number'
          ? fresh.image_credits_used
          : creditsUsedAfter - undelivered;
    }

    // Credits were charged at reservation time (minus any refund just above),
    // so there is no increment here.
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
        // What was asked for vs. what survived — makes "which styles do people
        // actually pick, and which ones keep failing" answerable later.
        concepts: selected.map(({ concept }) => concept.key),
        concepts_delivered: thumbs.map((t) => t.conceptKey),
        // Billing audit trail. Without it, a "why was I charged 4?" question
        // after a partial failure has no answer anywhere in the system.
        images_charged: reservation.charged,
        images_refunded: undelivered,
        credits_after: creditsUsedAfter,
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
      image_credits_used: creditsUsedAfter,
      image_credits_limit: reservation.limit,
      images_charged: thumbs.length,
      // Transition safety, remove after one release: a browser tab still
      // running the pre-deploy bundle reads these two keys and would render
      // "remaining NaN" without them.
      generations_used: creditsUsedAfter,
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
