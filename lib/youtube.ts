export function extractVideoId(url: string): string | null {
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

export type VideoMetadata = {
  title: string;
  description: string;
  channelTitle: string;
  channelId: string;
};

export type ChannelInfo = {
  channelId: string;
  channelTitle: string;
  avatarUrl: string | null;
};

function ytKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error('YOUTUBE_API_KEY not configured');
  return key;
}

export async function fetchVideoMetadata(videoId: string): Promise<VideoMetadata> {
  const url = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet&key=${ytKey()}`;
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
    channelId: item.snippet.channelId as string,
  };
}

export async function fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
  const url = `https://www.googleapis.com/youtube/v3/channels?id=${channelId}&part=snippet&key=${ytKey()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube channels API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const item = data.items?.[0];
  if (!item) {
    return { channelId, channelTitle: '', avatarUrl: null };
  }
  const thumbs = item.snippet?.thumbnails || {};
  // Prefer high (800px) → medium (240px) → default (88px).
  const avatarUrl: string | null =
    thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || null;
  return {
    channelId,
    channelTitle: item.snippet?.title || '',
    avatarUrl,
  };
}

export async function fetchAvatarBuffer(avatarUrl: string): Promise<Buffer> {
  const res = await fetch(avatarUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch avatar: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
