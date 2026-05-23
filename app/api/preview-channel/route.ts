import { NextResponse, type NextRequest } from 'next/server';
import { extractVideoId, fetchVideoMetadata, fetchChannelInfo } from '@/lib/youtube';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const youtubeUrl = typeof body.youtube_url === 'string' ? body.youtube_url.trim() : '';
    if (!youtubeUrl) {
      return NextResponse.json({ error: 'youtube_url is required' }, { status: 400 });
    }
    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) {
      return NextResponse.json({ error: 'Invalid YouTube URL' }, { status: 400 });
    }

    const meta = await fetchVideoMetadata(videoId);
    const channel = await fetchChannelInfo(meta.channelId);

    return NextResponse.json({
      video_id: videoId,
      video_title: meta.title,
      channel_id: meta.channelId,
      channel_title: channel.channelTitle || meta.channelTitle,
      avatar_url: channel.avatarUrl,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
