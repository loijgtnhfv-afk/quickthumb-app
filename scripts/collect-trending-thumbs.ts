/**
 * scripts/collect-trending-thumbs.ts
 *
 * Pulls "most popular" videos from YouTube Data API v3 for JP and US,
 * downloads each video's maxres (or high) thumbnail, classifies by
 * YouTube `categoryId`, and drops the file into the matching
 * references/<style>/ folder.
 *
 * Old trending-* files are removed before fresh ones land, so the
 * folder never bloats. Manually curated images (anything NOT prefixed
 * with `trending-`) are preserved.
 *
 * Run locally or in GitHub Actions:
 *   $env:YOUTUBE_API_KEY="..."
 *   npm run collect-trending
 *
 * Cost: 1 quota unit per region * 2 regions = 2/day. Default quota is
 * 10,000/day, so this is essentially free.
 */
import { promises as fs } from 'fs';
import path from 'path';

const REGIONS = ['JP', 'US'] as const;
type Region = (typeof REGIONS)[number];

const PER_REGION = 50; // max allowed by API in a single call

// YouTube categoryId → our internal style slot. Categories outside this
// map are dropped (not all trending videos translate to a useful style).
const CATEGORY_TO_STYLE: Record<string, 'vlog' | 'tech' | 'gaming' | 'magazine'> = {
  '1':  'magazine', // Film & Animation — often has cover-style polish
  '10': 'magazine', // Music — covers / artist portraits
  '20': 'gaming',   // Gaming
  '22': 'vlog',     // People & Blogs
  '24': 'vlog',     // Entertainment — close enough to vlog energy
  '26': 'vlog',     // Howto & Style — lifestyle adjacent
  '27': 'tech',     // Education
  '28': 'tech',     // Science & Technology
};

// Keep at most N trending images per style across all regions, so the
// folder stays curated even after weeks of cron runs.
const MAX_TRENDING_PER_STYLE = 8;

interface YTVideoItem {
  id: string;
  snippet: {
    title: string;
    categoryId: string;
    thumbnails: {
      maxres?: { url: string };
      standard?: { url: string };
      high?: { url: string };
    };
  };
}

interface YTListResponse {
  items?: YTVideoItem[];
  error?: { message: string };
}

async function fetchTrending(apiKey: string, region: Region): Promise<YTVideoItem[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('chart', 'mostPopular');
  url.searchParams.set('regionCode', region);
  url.searchParams.set('maxResults', String(PER_REGION));
  url.searchParams.set('key', apiKey);
  const res = await fetch(url.toString());
  const json = (await res.json()) as YTListResponse;
  if (!res.ok || json.error) {
    throw new Error(
      `YouTube API ${region} failed: ${json.error?.message || res.statusText}`
    );
  }
  return json.items || [];
}

function pickThumbnailUrl(item: YTVideoItem): string | null {
  return (
    item.snippet.thumbnails.maxres?.url ||
    item.snippet.thumbnails.standard?.url ||
    item.snippet.thumbnails.high?.url ||
    null
  );
}

async function downloadJpeg(url: string, outPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(outPath, buf);
}

async function clearTrendingFiles(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith('trending-')) continue;
    await fs.unlink(path.join(dir, name));
    removed++;
  }
  return removed;
}

async function main() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error('YOUTUBE_API_KEY not set');
    process.exit(1);
  }

  const refsDir = path.join(process.cwd(), 'references');

  // Wipe previous trending-* files so we don't accumulate stale ones.
  for (const style of ['vlog', 'tech', 'gaming', 'magazine'] as const) {
    const removed = await clearTrendingFiles(path.join(refsDir, style));
    if (removed) console.log(`Removed ${removed} old trending-* from ${style}/`);
  }

  // Collect all candidates from both regions, then dedupe by videoId so a
  // video popular in both JP and US doesn't fight itself for a slot.
  const candidatesByStyle = new Map<
    'vlog' | 'tech' | 'gaming' | 'magazine',
    Array<{ videoId: string; region: Region; thumbUrl: string; title: string }>
  >();

  for (const region of REGIONS) {
    console.log(`Fetching trending in ${region}...`);
    let items: YTVideoItem[];
    try {
      items = await fetchTrending(apiKey, region);
    } catch (err) {
      console.error(err);
      continue;
    }
    console.log(`  ${items.length} videos`);
    for (const item of items) {
      const style = CATEGORY_TO_STYLE[item.snippet.categoryId];
      if (!style) continue;
      const thumbUrl = pickThumbnailUrl(item);
      if (!thumbUrl) continue;
      const list = candidatesByStyle.get(style) || [];
      // Skip duplicates from the other region.
      if (list.some((c) => c.videoId === item.id)) continue;
      list.push({
        videoId: item.id,
        region,
        thumbUrl,
        title: item.snippet.title,
      });
      candidatesByStyle.set(style, list);
    }
  }

  // Take top MAX_TRENDING_PER_STYLE for each style (most-popular ordering is
  // preserved as returned by the API).
  let totalDownloaded = 0;
  for (const [style, list] of candidatesByStyle.entries()) {
    const slice = list.slice(0, MAX_TRENDING_PER_STYLE);
    console.log(`\n[${style}] downloading ${slice.length} thumbnails`);
    for (const c of slice) {
      const outPath = path.join(
        refsDir,
        style,
        `trending-${c.region}-${c.videoId}.jpg`
      );
      try {
        await downloadJpeg(c.thumbUrl, outPath);
        console.log(`  ✓ ${c.region} ${c.videoId}  — ${c.title.slice(0, 60)}`);
        totalDownloaded++;
      } catch (err) {
        console.warn(`  ✗ ${c.region} ${c.videoId}:`, (err as Error).message);
      }
    }
  }

  console.log(`\nDone. ${totalDownloaded} trending thumbnails written.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
