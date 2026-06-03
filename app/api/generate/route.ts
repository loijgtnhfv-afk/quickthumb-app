import { NextResponse, type NextRequest } from 'next/server';
import Replicate from 'replicate';
import Anthropic from '@anthropic-ai/sdk';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { generateNbpThumbnail, NBP_CONCEPTS } from '@/lib/nbp';
import { extractVideoId, fetchVideoMetadata } from '@/lib/youtube';

export const maxDuration = 60;
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
    const msg = await anthropic.messages.create({
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
    });
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
    const youtubeUrl = typeof body.youtube_url === 'string' ? body.youtube_url.trim() : '';
    // Face hero comes ONLY from the user's own uploaded photo (persona) — never
    // a third party's. The video URL is used for topic/hooks only. Without a
    // persona, NBP generates a faceless topical scene (legally safe).
    const personaUrl = typeof body.persona_url === 'string' ? body.persona_url.trim() : '';
    const customTextRaw =
      typeof body.custom_text === 'string' ? body.custom_text.trim() : '';
    const customText = customTextRaw.slice(0, 60);
    if (!youtubeUrl) {
      return NextResponse.json({ error: 'youtube_url is required' }, { status: 400 });
    }

    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) {
      return NextResponse.json({ error: 'Invalid YouTube URL' }, { status: 400 });
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('plan, generations_used, generations_limit')
      .eq('id', user.id)
      .single();
    if (profileError || !profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 500 });
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

    // Identity reference = the user's own uploaded persona photo, if any.
    const faceRefUrls = personaUrl ? [personaUrl] : [];
    const hasFace = faceRefUrls.length > 0;

    // Per-concept hook: user's custom overlay wins; else an LLM hook in the
    // concept's language (native vs English); else the title fallback.
    const hookFor = (concept: (typeof NBP_CONCEPTS)[number], i: number): string => {
      if (customText) return customText;
      if (concept.lang === 'en') return hooksEn[i % Math.max(1, hooksEn.length)] || fbEn;
      return hooksNative[i % Math.max(1, hooksNative.length)] || fbNative;
    };
    const prompts = NBP_CONCEPTS.map((c, i) => c.build(hookFor(c, i), topic, hasFace));

    const admin = createServiceClient();
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
      return NextResponse.json({ error: 'Failed to record generation' }, { status: 500 });
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
      const msg = genError instanceof Error ? genError.message : 'Generation failed';
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    await admin
      .from('generations')
      .update({ status: 'completed', thumbnail_urls: thumbs.map((t) => t.url) })
      .eq('id', generationId);

    await admin
      .from('profiles')
      .update({ generations_used: profile.generations_used + 1 })
      .eq('id', user.id);

    await admin.from('usage_logs').insert({
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
      generations_used: profile.generations_used + 1,
      generations_limit: profile.generations_limit,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    console.error('API /generate error', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
