/**
 * scripts/collect-trending-thumbs.ts
 *
 * Collects high-performing, ON-STYLE reference thumbnails for each of our 4
 * style slots using YouTube Data API v3 *search* (NOT the trending chart).
 *
 * Why search instead of `chart=mostPopular`: the trending chart in JP/US is
 * dominated by music videos, K-pop, and movie trailers, and YouTube's coarse
 * `categoryId` doesn't map cleanly to our styles. Feeding those into the
 * "vlog"/"tech" buckets gave off-style references (and Claude Vision rightly
 * refused to extract a "cozy vlog" style from anime MV thumbnails). Searching
 * per-style queries ordered by view count gives us thumbnails that actually
 * belong to the style AND are proven high performers — a good style ceiling.
 *
 * Flow per style:
 *   1. Run each query via search.list (type=video, order=viewCount, recent).
 *   2. Collect candidate videoIds (deduped).
 *   3. videos.list to fetch maxres thumbnail + statistics.viewCount.
 *   4. Keep the top MAX_PER_STYLE by view count, download maxres (or high).
 *
 * Old `trending-*` files are removed before fresh ones land, so the folder
 * never bloats. Manually curated images (anything NOT prefixed with
 * `trending-`) are preserved and define the aspirational ceiling.
 *
 * Run locally or in GitHub Actions:
 *   $env:YOUTUBE_API_KEY="..."
 *   npm run collect-trending
 *
 * Quota: search.list costs 100 units/call, videos.list 1 unit. With
 * QUERIES_PER_STYLE queries x 4 styles + 4 videos.list batches that's roughly
 * (queries * 4 * 100) + 4 units per run. Default quota is 10,000/day and this
 * runs weekly, so it stays comfortably free.
 */
import { promises as fs } from 'fs';
import path from 'path';

const STYLES = ['vlog', 'tech', 'gaming', 'magazine'] as const;
type Style = (typeof STYLES)[number];

// Per-style search queries. Ordered by view count, these surface the
// best-performing (= best-designed) thumbnails in each niche, which is a solid
// proxy for "the style done well". Tweak freely — one edit here re-aims a slot.
const STYLE_QUERIES: Record<Style, string[]> = {
  vlog: ['day in my life vlog', 'morning routine aesthetic', 'cozy daily vlog'],
  tech: ['tech review', 'software tutorial', 'how it works explained'],
  gaming: ['gameplay walkthrough', "let's play", 'esports highlights'],
  magazine: ['cinematic short film', 'fashion editorial', 'celebrity interview portrait'],
};

// Keep at most N reference images per style, so the folder stays curated even
// after weeks of cron runs.
const MAX_PER_STYLE = 8;

// How many search results to pull per query before ranking by view count.
const PER_QUERY = 10;

// Only consider videos published within this window, so references reflect
// what's performing *now* rather than all-time classics.
const RECENCY_MONTHS = 18;

interface SearchItem {
  id: { videoId?: string };
}

interface SearchResponse {
  items?: SearchItem[];
  error?: { message: string };
}

interface VideoItem {
  id: string;
  snippet: {
    title: string;
    channelTitle: string;
    thumbnails: {
      maxres?: { url: string };
      standard?: { url: string };
      high?: { url: string };
    };
  };
  statistics?: { viewCount?: string };
}

interface VideosResponse {
  items?: VideoItem[];
  error?: { message: string };
}

function publishedAfterIso(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - RECENCY_MONTHS);
  return d.toISOString();
}

async function searchVideoIds(
  apiKey: string,
  query: string,
  publishedAfter: string
): Promise<string[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('q', query);
  url.searchParams.set('type', 'video');
  url.searchParams.set('order', 'viewCount');
  // Exclude Shorts. order=viewCount is otherwise dominated by vertical 9:16
  // Shorts (100M+ views), whose maxres thumbnails are pillarboxed (blurred
  // side panels) — Vision then "learns" a vertical/triptych composition, which
  // is wrong for our 16:9 landscape thumbnails. videoDuration=medium (4–20 min)
  // guarantees long-form landscape videos with purpose-designed thumbnails,
  // since Shorts cap out at ~3 min.
  url.searchParams.set('videoDuration', 'medium');
  url.searchParams.set('maxResults', String(PER_QUERY));
  url.searchParams.set('publishedAfter', publishedAfter);
  url.searchParams.set('relevanceLanguage', 'en');
  url.searchParams.set('safeSearch', 'moderate');
  url.searchParams.set('key', apiKey);
  const res = await fetch(url.toString());
  const json = (await res.json()) as SearchResponse;
  if (!res.ok || json.error) {
    throw new Error(`search "${query}" failed: ${json.error?.message || res.statusText}`);
  }
  return (json.items || [])
    .map((it) => it.id.videoId)
    .filter((v): v is string => typeof v === 'string');
}

async function fetchVideoDetails(apiKey: string, ids: string[]): Promise<VideoItem[]> {
  if (ids.length === 0) return [];
  const out: VideoItem[] = [];
  // videos.list accepts up to 50 ids per call.
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', 'snippet,statistics');
    url.searchParams.set('id', chunk.join(','));
    url.searchParams.set('maxResults', '50');
    url.searchParams.set('key', apiKey);
    const res = await fetch(url.toString());
    const json = (await res.json()) as VideosResponse;
    if (!res.ok || json.error) {
      throw new Error(`videos.list failed: ${json.error?.message || res.statusText}`);
    }
    out.push(...(json.items || []));
  }
  return out;
}

function pickThumbnailUrl(item: VideoItem): string | null {
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

async function collectForStyle(
  apiKey: string,
  style: Style,
  refsDir: string,
  publishedAfter: string
): Promise<number> {
  const queries = STYLE_QUERIES[style];
  const ids = new Set<string>();
  for (const q of queries) {
    try {
      const found = await searchVideoIds(apiKey, q, publishedAfter);
      found.forEach((id) => ids.add(id));
      console.log(`  [${style}] "${q}" → ${found.length} ids`);
    } catch (err) {
      console.warn(`  [${style}] ${(err as Error).message}`);
    }
  }
  if (ids.size === 0) {
    console.warn(`  [${style}] no candidates found — skipping`);
    return 0;
  }

  let details: VideoItem[];
  try {
    details = await fetchVideoDetails(apiKey, [...ids]);
  } catch (err) {
    console.warn(`  [${style}] ${(err as Error).message}`);
    return 0;
  }

  // Rank by view count desc, keep the top MAX_PER_STYLE.
  const ranked = details
    .map((v) => ({ v, views: Number(v.statistics?.viewCount || '0') }))
    .sort((a, b) => b.views - a.views)
    .slice(0, MAX_PER_STYLE);

  let downloaded = 0;
  for (const { v, views } of ranked) {
    const thumbUrl = pickThumbnailUrl(v);
    if (!thumbUrl) continue;
    const outPath = path.join(refsDir, style, `trending-${v.id}.jpg`);
    try {
      await downloadJpeg(thumbUrl, outPath);
      console.log(
        `  ✓ ${v.id}  ${(views / 1e6).toFixed(1)}M  — ${v.snippet.title.slice(0, 55)}`
      );
      downloaded++;
    } catch (err) {
      console.warn(`  ✗ ${v.id}: ${(err as Error).message}`);
    }
  }
  return downloaded;
}

async function main() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error('YOUTUBE_API_KEY not set');
    process.exit(1);
  }

  const refsDir = path.join(process.cwd(), 'references');
  const publishedAfter = publishedAfterIso();
  console.log(`Collecting per-style reference thumbs (published after ${publishedAfter})`);

  let total = 0;
  for (const style of STYLES) {
    // Wipe previous trending-* files so we don't accumulate stale ones.
    const removed = await clearTrendingFiles(path.join(refsDir, style));
    if (removed) console.log(`[${style}] removed ${removed} old trending-*`);
    console.log(`[${style}] searching ${STYLE_QUERIES[style].length} queries...`);
    total += await collectForStyle(apiKey, style, refsDir, publishedAfter);
  }

  console.log(`\nDone. ${total} reference thumbnails written.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
