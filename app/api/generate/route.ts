import { NextResponse, type NextRequest } from 'next/server';
import Replicate from 'replicate';
import { createClient, createServiceClient } from '@/lib/supabase/server';

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
    console.error('YouTube API error', { status: res.status, body, keyLen: apiKey.length, keyHead: apiKey.slice(0, 6) });
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

function buildPrompts(title: string): string[] {
  const safeTitle = title.replace(/["]/g, '').slice(0, 120);
  return [
    `Bold YouTube thumbnail design about "${safeTitle}". Large dramatic typography, high contrast, eye-catching colors, professional photography style, cinematic lighting, 16:9 aspect ratio.`,
    `Vibrant YouTube thumbnail about "${safeTitle}". Bright gradient background, expressive face or character, modern design, strong emotional appeal, 16:9 aspect ratio.`,
    `Minimalist YouTube thumbnail about "${safeTitle}". Single bold subject centered, clean negative space, modern flat design, single vivid accent color, 16:9 aspect ratio.`,
    `Dramatic YouTube thumbnail about "${safeTitle}". Neon glow lighting, dark moody background, intense focal point, social media optimized, 16:9 aspect ratio.`,
  ];
}

async function generateThumbnail(prompt: string): Promise<string> {
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

async function downloadAndStore(
  imageUrl: string,
  userId: string,
  generationId: string,
  index: number
): Promise<string> {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const path = `${userId}/${generationId}/thumb-${index}.png`;

  const admin = createServiceClient();
  const { error } = await admin.storage
    .from('thumbnails')
    .upload(path, buf, { contentType: 'image/png', upsert: true });
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
    const prompts = buildPrompts(meta.title);

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

    let urls: string[];
    try {
      const replicateUrls = await Promise.all(prompts.map((p) => generateThumbnail(p)));
      urls = await Promise.all(
        replicateUrls.map((u, i) => downloadAndStore(u, user.id, generationId, i + 1))
      );
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
      .update({ status: 'completed', thumbnail_urls: urls })
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
      thumbnails: urls.map((url, i) => ({
        id: i + 1,
        url,
        prompt: prompts[i],
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
