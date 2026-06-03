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

// NOTE: third-party channel-avatar fetching (fetchChannelInfo / fetchAvatarBuffer)
// was removed with the appeal-pivot v2 — the face hero now comes ONLY from the
// user's own uploaded persona (consent / right-of-publicity), never a channel's
// avatar. The video URL is used for the topic/hooks only.
