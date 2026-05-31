import { NextResponse, type NextRequest } from 'next/server';
import Replicate from 'replicate';
import Anthropic from '@anthropic-ai/sdk';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import descriptorsJson from '@/references/descriptors.json';
import {
  composeThumbnail,
  composeFaceHero,
  styleBackdrop,
  composeQuadGrid,
  composeQuadGridRaw,
  cleanTitle,
  extractDisplayTitle,
  ALL_STYLES,
  STYLE_DESCRIPTIONS,
  QUAD_GRID_DESCRIPTION,
  type ThumbnailStyle,
} from '@/lib/thumbnail-compose';
import {
  extractVideoId,
  fetchVideoMetadata,
  fetchChannelInfo,
} from '@/lib/youtube';

export const maxDuration = 60;
export const runtime = 'nodejs';

const NEGATIVE_PROMPT =
  'NO text, NO letters, NO words, NO captions, NO logos, NO writing, NO glyphs, NO numbers, NO signs, NO screens or monitors displaying any characters, NO fake inscriptions, NO subtitles, NO Japanese characters, NO kanji, NO hiragana, NO katakana, NO Chinese characters, NO Korean characters, NO Asian text, NO scribbles, NO calligraphy, NO posters, NO banners, NO street signs, NO shop fronts, NO book covers, NO newspaper text, NO graffiti, NO billboards';

// Style descriptors extracted from real reference thumbnails (run
// `npm run extract-descriptors` to refresh after dropping images into
// references/<style>/). Empty / missing keys are fine — buildStylePrompt
// just skips the append in that case.
type StyleDescriptor = { descriptor: string; imageCount: number; updatedAt: string };
const descriptors = descriptorsJson as Partial<Record<ThumbnailStyle, StyleDescriptor>>;
function descriptorClauseFor(style: ThumbnailStyle): string {
  const entry = descriptors[style];
  if (!entry || !entry.descriptor) return '';
  // Prefix as a clear "look like..." instruction so Flux treats it as
  // additional style guidance rather than free-form scene content.
  return ` Visual style reference (match this look): ${entry.descriptor}`;
}

// CJK / fullwidth / kana ranges — anything Flux will try to render as fake
// "Japanese-ish" glyphs if it sees it in the prompt.
const CJK_RANGE = /[　-鿿豈-﫿＀-￯]/g;

function stripCJK(s: string): string {
  return s.replace(CJK_RANGE, ' ').replace(/\s+/g, ' ').trim();
}

function hasCJK(s: string): boolean {
  return /[　-鿿豈-﫿＀-￯]/.test(s);
}

// ---- LLM translation -------------------------------------------------------
// Flux Schnell scribbles fake "Japanese-ish" text on any sign/poster/screen
// it draws when the prompt contains CJK characters. Stripping CJK leaves the
// prompt with no topic signal, so Flux falls back to generic Asian street
// scenes (which then naturally contain signage = fake glyphs). The fix is to
// TRANSLATE the title/channel/desc into English up front. Flux can render
// English text reasonably, so even if it adds signage, it stays coherent.

interface EnglishContext {
  title: string;
  channel: string;
  topic: string;
}

interface ThumbAnalysis {
  // English translation for the Flux prompt (null = use the original text as-is,
  // i.e. English input or the LLM was unavailable).
  en: EnglishContext | null;
  // 2-4 word punchy overlay HOOKS in the title's OWN language (NOT stripped of
  // CJK — these are Satori overlay text, not Flux prompt text). Empty on failure.
  hooks: string[];
}

// One Haiku call does double duty: (1) translate the metadata to English for the
// Flux prompt (only meaningful when the input is CJK), and (2) write short,
// punchy thumbnail HOOKS to overlay instead of the literal video title. Any
// failure degrades gracefully to { en: null, hooks: [] } so the caller falls
// back to the shortened title and the pipeline never breaks.
async function analyzeForThumbnail(
  title: string,
  channel: string,
  description: string
): Promise<ThumbAnalysis> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY not set — no hooks/translation, using title fallback');
    return { en: null, hooks: [] };
  }
  const needsTranslation = hasCJK(title) || hasCJK(channel) || hasCJK(description);
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: `You are a YouTube thumbnail expert. From this video metadata, produce JSON with two things:
(1) "translation": clean ENGLISH for an AI image-generation prompt — {"title": <max 12 words>, "channel": <max 6 words>, "topic": <one visual sentence, max 20 words>}. Concise, visual, concrete nouns.
(2) "hooks": an array of 4 SHORT thumbnail hook phrases — NOT the title. Each is punchy curiosity/stakes/emotion copy: max 4 words in English, or max 8 characters in Japanese. Write them in the SAME LANGUAGE as the Title. Examples: "I QUIT", "$0 vs $1M", "GONE WRONG", "まさかの結末", "新記録", "1日で激変".

Title: ${title}
Channel: ${channel}
Description (first 400 chars): ${(description || '').slice(0, 400)}

Reply with ONLY this JSON, no preamble, no code fences:
{"translation":{"title":"...","channel":"...","topic":"..."},"hooks":["...","...","...","..."]}`,
        },
      ],
    });
    const text = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '';
    // Tolerate a code fence in case the model wraps the JSON despite the instruction.
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
    // Hooks keep their original language (CJK allowed). Drop empties and absurdly
    // long entries (a hook should be a few words, never a sentence).
    const hooks: string[] = Array.isArray(parsed.hooks)
      ? parsed.hooks
          .map((h: unknown) => String(h ?? '').trim())
          .filter((h: string) => h.length > 0 && h.length <= 40)
          .slice(0, 4)
      : [];
    return { en, hooks };
  } catch (err) {
    console.warn('LLM analysis failed (falling back to title):', err);
    return { en: null, hooks: [] };
  }
}

// Strip URLs, hashtags, "subscribe" boilerplate so a short context snippet of
// the description can be safely fed to Flux without crowding the prompt.
function summarizeDescription(description: string, maxChars: number = 200): string {
  if (!description) return '';
  return description
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[#＃][^\s#＃]+/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
    .trim();
}

function buildStylePrompt(
  title: string,
  description: string,
  channel: string,
  style: ThumbnailStyle,
  // When the LLM translator was NOT used (no API key, or English-only input)
  // we don't trust Flux with a topic that might still look "Asian-coded"
  // enough to summon a generic Tokyo street with fake-character signage.
  // Push hard toward studio portraits with no environmental signage.
  enforceCleanBackdrop: boolean = false
): string {
  // Strip CJK from every user-supplied bit BEFORE it touches the prompt —
  // Flux Schnell loves to scribble fake Japanese characters on signs / shirts
  // whenever it sees CJK in its input.
  const cleanedTitle = stripCJK(cleanTitle(title)).replace(/["]/g, '').slice(0, 120);
  const subjectPhrase = cleanedTitle.length >= 3 ? `"${cleanedTitle}"` : 'the subject';
  const safeChannel = stripCJK(channel).replace(/["]/g, '').slice(0, 60);
  const channelPart = safeChannel ? ` from a YouTube video by "${safeChannel}"` : '';
  const ctxRaw = summarizeDescription(description, 200);
  // If description has any CJK, drop it entirely — partial-stripping leaves
  // an incoherent english fragment that doesn't help Flux.
  const safeCtx = hasCJK(ctxRaw) ? '' : ctxRaw;
  const ctxPart = safeCtx ? ` Context from the video description: ${safeCtx}.` : '';
  const tail = `${NEGATIVE_PROMPT}. 16:9 aspect ratio.`;

  // Strong anti-signage clause used when we can't trust the topic. Empty
  // string in the trusted-topic path so rich scenes are still allowed.
  const cleanGuard = enforceCleanBackdrop
    ? ' Shot as a tight studio-style portrait or close-up of the hero subject against a plain colored or softly blurred backdrop. ABSOLUTELY NO street scenes, NO shop fronts, NO neon signs, NO posters, NO billboards, NO graffiti, NO crowd scenes, NO signage of any kind anywhere in the frame.'
    : '';

  const photoTopic = `A photographic scene visibly tied to the topic of ${subjectPhrase}${channelPart}, with a clear hero subject related to the topic.${ctxPart} High quality, photorealistic. Plain composition with no signs, posters, banners, or text-bearing objects in the frame.${cleanGuard}`;

  const refClause = descriptorClauseFor(style);

  switch (style) {
    case 'vlog':
      return `${photoTopic} Shot as warm intimate lifestyle photography: soft golden-hour daylight, shallow depth of field, cream and peach palette, slightly blurred background, cozy personal vlog aesthetic. The subject is prominent and recognizable.${refClause} ${tail}`;
    case 'tech':
      // Avoid screens/monitors — Flux loves to scribble fake glyphs on them.
      return `${photoTopic} Shot as a sleek modern editorial portrait or hero-object photograph: crisp directional studio lighting, cool palette with cyan and deep navy accents, clean composition, premium magazine feel. The hero subject is a person or central object related to the topic — NOT a computer, NOT a monitor, NOT a desk setup, NOT a phone screen. Subject biased right, left side slightly darker for overlay text.${refClause} ${tail}`;
    case 'gaming':
      return `${photoTopic} Shot as a cinematic high-energy moment: dramatic dark lighting with vibrant red ${enforceCleanBackdrop ? 'RIM LIGHT (no neon signs)' : 'and neon accents'}, deep blacks, strong rim light, intense atmosphere, hero shot of the topic subject. Bold action vibe with comic-book energy.${refClause} ${tail}`;
    case 'magazine':
      // Print-magazine cover energy — hero subject biased right, negative
      // space top-left where the kicker + display title will land.
      return `${photoTopic} Shot as a high-end print-magazine cover photograph (Vogue / TIME / GQ / National Geographic feel): refined editorial styling, rich tonal palette with one strong accent color, deliberate negative space at the TOP-LEFT of the frame for cover type, hero subject biased to the right two-thirds of the frame. Premium curated composition, NOT casual snapshot.${refClause} ${tail}`;
  }
}

async function generateBackground(prompt: string): Promise<string> {
  const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  const output = await replicate.run('black-forest-labs/flux-schnell', {
    input: {
      prompt,
      aspect_ratio: '16:9',
      num_outputs: 1,
      output_format: 'png',
      output_quality: 90,
    },
  });
  if (Array.isArray(output) && output[0]) {
    const first = output[0];
    if (typeof first === 'string') return first;
    if (typeof (first as { url?: () => string }).url === 'function') {
      return (first as { url: () => string }).url();
    }
  }
  throw new Error('Unexpected Replicate output shape');
}

// ---- Real-face cut-out (face-hero mode) ------------------------------------
// Resolve the bg-removal model version once per cold start (the bare slug 404s;
// the model endpoint needs a pinned version id).
let bgRemoverVersion: string | null = null;
async function resolveBgRemover(replicate: Replicate): Promise<string | null> {
  if (bgRemoverVersion) return bgRemoverVersion;
  try {
    const m = (await replicate.models.get('lucataco', 'remove-bg')) as {
      latest_version?: { id?: string };
    };
    bgRemoverVersion = m.latest_version?.id ?? null;
  } catch (e) {
    console.warn('resolveBgRemover failed:', e);
    bgRemoverVersion = null;
  }
  return bgRemoverVersion;
}

// YouTube avatar URLs default to ~s88; bump to s800 for a usable hero cut-out.
function upsizeAvatarUrl(url: string): string {
  return url.replace(/=s\d+(-c)?/, '=s800-c').replace(/\/s\d+-/, '/s800-');
}

// Fetch the channel avatar and remove its background -> transparent PNG of the
// subject. Returns null on ANY failure so the caller falls back to scene mode.
async function getFaceCutout(channelId: string): Promise<Buffer | null> {
  try {
    const channel = await fetchChannelInfo(channelId);
    if (!channel.avatarUrl) return null;
    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    const version = await resolveBgRemover(replicate);
    if (!version) return null;
    const out = await replicate.run(
      `lucataco/remove-bg:${version}` as `${string}/${string}:${string}`,
      { input: { image: upsizeAvatarUrl(channel.avatarUrl) } }
    );
    let url: string | undefined;
    if (typeof out === 'string') url = out;
    else if (Array.isArray(out) && typeof out[0] === 'string') url = out[0];
    else if (out && typeof (out as { url?: () => string }).url === 'function') {
      url = (out as { url: () => string }).url();
    }
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.warn('getFaceCutout failed (falling back to scene mode):', e);
    return null;
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
    // Face-hero is the default now: we try to make the creator's real face the
    // hero. An explicit use_face:false opts out (some channels are faceless).
    const wantFace = body.use_face !== false;
    const customTextRaw =
      typeof body.custom_text === 'string' ? body.custom_text.trim() : '';
    // Cap user-supplied overlay text — composers wrap to 2 lines and large
    // strings break the layout.
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
    // One LLM call: translate the metadata to English for the Flux prompt (when
    // CJK) AND write short punchy overlay HOOKS. Degrades to { en: null,
    // hooks: [] } on failure, so prompts fall back to stripCJK'd originals and
    // the overlay falls back to the shortened title.
    const { en, hooks } = await analyzeForThumbnail(meta.title, meta.channelTitle, meta.description);
    const promptTitle = en ? en.title : meta.title;
    const promptChannel = en ? en.channel : meta.channelTitle;
    const promptDescription = en ? en.topic : meta.description;
    // If we don't have a trusted English topic AND the original was CJK,
    // the prompt has no real signal — force clean studio backdrops so Flux
    // can't fall back to Tokyo-street scenes filled with fake signage.
    const enforceCleanBackdrop = !en && hasCJK(meta.title + meta.channelTitle + meta.description);
    const stylePrompts = ALL_STYLES.map((s) =>
      buildStylePrompt(promptTitle, promptDescription, promptChannel, s, enforceCleanBackdrop)
    );
    // Visible overlay text per style. Priority: the user's custom overlay wins;
    // otherwise an LLM-written punchy HOOK (a different one per style for A/B
    // variety — short curiosity/stakes copy, NOT the literal title); otherwise
    // the shortened title as a no-API fallback so the pipeline never breaks.
    const fallbackOverlay = extractDisplayTitle(meta.title, 24);
    const overlayTextFor = (i: number) =>
      customText || (hooks.length ? hooks[i % hooks.length] : '') || fallbackOverlay;

    // Try to make the creator's real face the hero. When we get a clean cut-out,
    // we enter "face mode": skip Flux scenes, place the face on a clean gradient
    // backdrop, overlay the hook. Otherwise fall back to AI scene backgrounds.
    const faceCutout = wantFace ? await getFaceCutout(meta.channelId) : null;
    const faceMode = faceCutout !== null;

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
        prompts: stylePrompts,
        status: 'processing',
      })
      .select('id')
      .single();
    if (insertError || !insertRow) {
      return NextResponse.json({ error: 'Failed to record generation' }, { status: 500 });
    }
    const generationId = insertRow.id as string;

    let composedUrls: string[];
    let rawUrls: string[];
    try {
      // 1) Backgrounds. Face mode: clean per-style gradient backdrops (the real
      // face is the hero, so Flux is skipped — faster and cheaper). Scene mode:
      // the 4 AI scene backgrounds as before.
      const bgBuffers = faceMode
        ? await Promise.all(ALL_STYLES.map((s) => styleBackdrop(s)))
        : await Promise.all(
            stylePrompts.map(async (prompt) => {
              const bgUrl = await generateBackground(prompt);
              const bgRes = await fetch(bgUrl);
              if (!bgRes.ok) throw new Error(`Failed to fetch background: ${bgRes.status}`);
              return Buffer.from(await bgRes.arrayBuffer());
            })
          );

      // 2) Compose 4 styled thumbnails. In face mode, composite the cut-out face
      // as the hero onto its backdrop first, then overlay the hook.
      const composedBuffers = await Promise.all(
        ALL_STYLES.map(async (style, i) => {
          try {
            const base =
              faceMode && faceCutout
                ? await composeFaceHero(bgBuffers[i], faceCutout, style)
                : bgBuffers[i];
            return await composeThumbnail(base, overlayTextFor(i), style);
          } catch (e) {
            // Never let one style's face-composite failure sink the whole
            // generation — fall back to the bare backdrop + hook.
            console.warn(`face-hero compose failed for ${style}, using plain backdrop:`, e);
            return composeThumbnail(bgBuffers[i], overlayTextFor(i), style);
          }
        })
      );

      // 3) 5th composite: keyword spotlight over a 2x2 tile of the 4 backgrounds
      // (scene bgs, or the gradient backdrops in face mode). Quad keyword: the
      // user's custom overlay if any, else the RAW meta.title so extractKeyword
      // can split on 【】 | / : etc. and pick a punchy keyword.
      const [quadBuffer, quadRawBuffer] = await Promise.all([
        composeQuadGrid(bgBuffers, meta.title, customText || undefined),
        composeQuadGridRaw(bgBuffers),
      ]);

      // 4) Upload everything in parallel.
      const composedTargets = [...composedBuffers, quadBuffer];
      const rawTargets = [...bgBuffers, quadRawBuffer];
      [composedUrls, rawUrls] = await Promise.all([
        Promise.all(
          composedTargets.map((buf, i) =>
            uploadPng(buf, user.id, generationId, `thumb-${i + 1}`)
          )
        ),
        Promise.all(
          rawTargets.map((buf, i) =>
            uploadPng(buf, user.id, generationId, `raw-${i + 1}`)
          )
        ),
      ]);
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
      .update({ status: 'completed', thumbnail_urls: composedUrls })
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
        face_mode: faceMode,
        custom_text: customText || null,
      },
    });

    return NextResponse.json({
      id: generationId,
      thumbnails: composedUrls.map((url, i) => ({
        id: i + 1,
        url,
        image_url: rawUrls[i],
        // style_key is the i18n lookup key (styles.<key>) — page picks the
        // localized description. `prompt` stays as the English fallback for
        // older clients / debugging.
        style_key: i < ALL_STYLES.length ? ALL_STYLES[i] : 'quad',
        prompt:
          i < ALL_STYLES.length
            ? STYLE_DESCRIPTIONS[ALL_STYLES[i]]
            : QUAD_GRID_DESCRIPTION,
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
