import { NextResponse, type NextRequest } from 'next/server';
import Replicate from 'replicate';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import {
  composeThumbnail,
  composeQuadGrid,
  composeQuadGridRaw,
  ALL_STYLES,
  STYLE_DESCRIPTIONS,
  QUAD_GRID_DESCRIPTION,
  type ThumbnailStyle,
} from '@/lib/thumbnail-compose';

export const maxDuration = 60;
export const runtime = 'nodejs';

function extractVideoId(url: string): string | null {
  const patterns = [
    /youtube\.com\/watch\?v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/shorts\/([\w-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

async function fetchVideoMetadata(videoId: string) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error('YOUTUBE_API_KEY not configured');

  const url = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet&key=${apiKey}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const item = data.items?.[0];
  if (!item) throw new Error('Video not found or private');
  return {
    title: item.snippet.title as string,
    description: (item.snippet.description as string) || '',
    channelTitle: item.snippet.channelTitle as string,
  };
}

const NEGATIVE_PROMPT =
  'NO text, NO letters, NO words, NO captions, NO logos, NO writing of any kind anywhere in the image';

function buildStylePrompt(title: string, style: ThumbnailStyle): string {
  const safeTitle = title.replace(/["]/g, '').slice(0, 120);
  const tail = `${NEGATIVE_PROMPT}. 16:9 aspect ratio, high quality, professional photography.`;
  const topic = `inspired by the topic of "${safeTitle}"`;

  switch (style) {
    case 'vlog':
      return `Warm lifestyle photography ${topic}. Soft natural daylight, golden-hour cream/peach palette, shallow depth of field, cozy intimate vibe, slightly blurred background. Personal vlog aesthetic. Negative space at top and bottom for overlay text. ${tail}`;
    case 'tech':
      return `Sleek modern tech editorial product photography ${topic}. Crisp studio lighting, cool tones with cyan and deep navy accents, clean lines, premium gadget/desk-setup feel. Subject biased to the right; left side darker for overlay text. ${tail}`;
    case 'gaming':
      return `Cinematic high-energy action scene ${topic}. Dramatic dark lighting with vibrant red and neon accents, deep blacks, saturated highlights, strong rim light, intense atmosphere. Hero subject centered with the bottom area darker for overlay text. Comic-book style energy. ${tail}`;
    case 'editorial':
      return `Minimalist editorial magazine photography ${topic}. Refined composition, muted neutral palette (off-white, soft gray, warm beige), generous negative space, sophisticated calm mood, high-end print-magazine aesthetic. Subject in the upper half; lower third clean for overlay text. ${tail}`;
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
    const stylePrompts = ALL_STYLES.map((s) => buildStylePrompt(meta.title, s));

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
      // 1) Generate 4 style-specific backgrounds in parallel.
      const bgBuffers = await Promise.all(
        stylePrompts.map(async (prompt) => {
          const bgUrl = await generateBackground(prompt);
          const bgRes = await fetch(bgUrl);
          if (!bgRes.ok) throw new Error(`Failed to fetch background: ${bgRes.status}`);
          return Buffer.from(await bgRes.arrayBuffer());
        })
      );

      // 2) Compose 4 styled thumbnails, each using its own background.
      const composedBuffers = await Promise.all(
        ALL_STYLES.map((style, i) =>
          composeThumbnail(bgBuffers[i], meta.title, style)
        )
      );

      // 3) 5th composite: 4 different bgs tiled 2x2 + central keyword.
      // 5th raw: same tile, no keyword.
      const [quadBuffer, quadRawBuffer] = await Promise.all([
        composeQuadGrid(bgBuffers, meta.title),
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
      metadata: { video_id: videoId, title: meta.title },
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
