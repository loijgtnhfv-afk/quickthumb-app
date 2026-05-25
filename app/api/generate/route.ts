import { NextResponse, type NextRequest } from 'next/server';
import Replicate from 'replicate';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import {
  composeThumbnail,
  composeQuadGrid,
  composeQuadGridRaw,
  compositeAvatar,
  cleanTitle,
  extractDisplayTitle,
  ALL_STYLES,
  STYLE_DESCRIPTIONS,
  QUAD_GRID_DESCRIPTION,
  type ThumbnailStyle,
  type AvatarKind,
} from '@/lib/thumbnail-compose';
import {
  extractVideoId,
  fetchVideoMetadata,
  fetchChannelInfo,
  fetchAvatarBuffer,
} from '@/lib/youtube';

export const maxDuration = 60;
export const runtime = 'nodejs';

const NEGATIVE_PROMPT =
  'NO text, NO letters, NO words, NO captions, NO logos, NO writing, NO glyphs, NO numbers, NO signs, NO screens or monitors displaying any characters, NO fake inscriptions, NO subtitles, NO Japanese characters, NO kanji, NO hiragana, NO katakana, NO Chinese characters, NO Korean characters, NO Asian text, NO scribbles, NO calligraphy, NO posters, NO banners, NO street signs, NO shop fronts, NO book covers, NO newspaper text, NO graffiti, NO billboards';

// CJK / fullwidth / kana ranges — anything Flux will try to render as fake
// "Japanese-ish" glyphs if it sees it in the prompt.
const CJK_RANGE = /[　-鿿豈-﫿＀-￯]/g;

function stripCJK(s: string): string {
  return s.replace(CJK_RANGE, ' ').replace(/\s+/g, ' ').trim();
}

function hasCJK(s: string): boolean {
  return /[　-鿿豈-﫿＀-￯]/.test(s);
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
  style: ThumbnailStyle
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

  // Photo-style topic prefix shared by all 4 styles. The "plain composition"
  // clause discourages Flux from putting text-bearing props in the scene.
  const photoTopic = `A photographic scene visibly tied to the topic of ${subjectPhrase}${channelPart}, with a clear hero subject related to the topic.${ctxPart} High quality, photorealistic. Plain composition with no signs, posters, banners, or text-bearing objects in the frame.`;

  switch (style) {
    case 'vlog':
      return `${photoTopic} Shot as warm intimate lifestyle photography: soft golden-hour daylight, shallow depth of field, cream and peach palette, slightly blurred background, cozy personal vlog aesthetic. The subject is prominent and recognizable. ${tail}`;
    case 'tech':
      // Avoid screens/monitors — Flux loves to scribble fake glyphs on them.
      return `${photoTopic} Shot as a sleek modern editorial portrait or hero-object photograph: crisp directional studio lighting, cool palette with cyan and deep navy accents, clean composition, premium magazine feel. The hero subject is a person or central object related to the topic — NOT a computer, NOT a monitor, NOT a desk setup, NOT a phone screen. Subject biased right, left side slightly darker for overlay text. ${tail}`;
    case 'gaming':
      return `${photoTopic} Shot as a cinematic high-energy moment: dramatic dark lighting with vibrant red and neon accents, deep blacks, strong rim light, intense atmosphere, hero shot of the topic subject. Bold action vibe with comic-book energy. ${tail}`;
    case 'magazine':
      // Print-magazine cover energy — hero subject biased right, negative
      // space top-left where the kicker + display title will land.
      return `${photoTopic} Shot as a high-end print-magazine cover photograph (Vogue / TIME / GQ / National Geographic feel): refined editorial styling, rich tonal palette with one strong accent color, deliberate negative space at the TOP-LEFT of the frame for cover type, hero subject biased to the right two-thirds of the frame. Premium curated composition, NOT casual snapshot. ${tail}`;
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
    const useFace = body.use_face === true;
    const avatarKind: AvatarKind = body.avatar_kind === 'logo' ? 'logo' : 'face';
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
    const stylePrompts = ALL_STYLES.map((s) =>
      buildStylePrompt(meta.title, meta.description, meta.channelTitle, s)
    );
    // Shorter, cleaner headline for the visible overlay (strips
    // "(4K Remaster)", "www", etc. and limits to a punchy ~24 chars).
    // If the user typed a custom overlay, that wins over the auto-extracted one.
    const displayTitle = customText
      ? customText
      : extractDisplayTitle(meta.title, 24);

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
      // 1) Generate 4 style-specific backgrounds in parallel. If the user
      // opted in for face overlay, fetch the channel avatar in parallel too —
      // it doesn't block the AI bgs and any failure degrades silently.
      const [bgBuffers, avatarBuffer] = await Promise.all([
        Promise.all(
          stylePrompts.map(async (prompt) => {
            const bgUrl = await generateBackground(prompt);
            const bgRes = await fetch(bgUrl);
            if (!bgRes.ok) throw new Error(`Failed to fetch background: ${bgRes.status}`);
            return Buffer.from(await bgRes.arrayBuffer());
          })
        ),
        (async (): Promise<Buffer | null> => {
          if (!useFace) return null;
          try {
            const channel = await fetchChannelInfo(meta.channelId);
            if (!channel.avatarUrl) return null;
            return await fetchAvatarBuffer(channel.avatarUrl);
          } catch (e) {
            console.warn('Avatar fetch failed (continuing without):', e);
            return null;
          }
        })(),
      ]);

      // 2) Compose 4 styled thumbnails, each using its own background.
      // If we got an avatar, overlay it per-style after composition.
      const composedBuffers = await Promise.all(
        ALL_STYLES.map(async (style, i) => {
          const composed = await composeThumbnail(bgBuffers[i], displayTitle, style);
          if (!avatarBuffer) return composed;
          try {
            return await compositeAvatar(composed, avatarBuffer, style, avatarKind);
          } catch (e) {
            console.warn(`Avatar composite failed for ${style} (using bare thumb):`, e);
            return composed;
          }
        })
      );

      // 3) 5th composite: 4 different bgs tiled 2x2 + central keyword.
      // 5th raw: same tile, no keyword. (Avatar is skipped on the quad grid —
      // the centered keyword owns the visual center.)
      const [quadBuffer, quadRawBuffer] = await Promise.all([
        composeQuadGrid(bgBuffers, displayTitle),
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
        use_face: useFace,
        avatar_kind: useFace ? avatarKind : null,
        custom_text: customText || null,
      },
    });

    return NextResponse.json({
      id: generationId,
      thumbnails: composedUrls.map((url, i) => ({
        id: i + 1,
        url,
        image_url: rawUrls[i],
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
