# References — visual style reference thumbnails

This folder holds **reference YouTube thumbnails** that Quickthumb learns
style cues from. The contents here never ship to users — they exist
solely to (a) tune the Flux prompts and (b) build a future LoRA training
corpus.

## Folder layout

```
references/
  vlog/        ← cozy lifestyle, daily life, "a day in my life" style thumbs
  tech/        ← how-to / tutorial / explainer style thumbs
  gaming/      ← gameplay, esports, manga / comic energy thumbs
  magazine/    ← polished editorial / cover-style thumbs
  descriptors.json   ← AUTO-GENERATED — do not hand-edit
```

Drop 5–15 images per style. JPG / PNG / WEBP all fine. Bigger thumbs
(YouTube's `maxres` URL) are better than tiny ones.

**Pick aspirational, not "good enough"** — these define the ceiling of
what Quickthumb tries to emulate.

## How the style descriptors get built

Once you've populated the folders, run:

```bash
$env:ANTHROPIC_API_KEY="sk-ant-..."   # PowerShell
npm run extract-descriptors
```

This sends batches of images per style to Claude Sonnet (Vision),
extracts a compact "style descriptor" for each, and writes them to
`references/descriptors.json`. The descriptor is a paragraph of visual
cues (palette, composition, lighting, typography) that gets appended to
the Flux prompt at generation time.

**Cost**: ~$0.05–0.15 per full run (all 4 styles), one-time per refresh.
**API key**: only required to RUN the script. The runtime image
generation does NOT need it — it just reads the resulting JSON.

## When to re-run

- After adding ≥5 new images to a folder
- Periodically (monthly?) so the style stays current with what's
  performing on YouTube right now
- After the auto-collector has dropped fresh examples (runs weekly)

## Auto-collector (per-style search)

Implemented as a weekly GitHub Actions cron — `.github/workflows/refresh-descriptors.yml`.

Every Monday 02:00 UTC (and on-demand via `workflow_dispatch`) the workflow:

1. For each style, runs that style's search queries against YouTube Data API
   v3 `search.list` (type=video, order=viewCount, duration=medium so Shorts are
   excluded, published within the last 18 months). See `STYLE_QUERIES` in
   `scripts/collect-trending-thumbs.ts`.
2. Fetches `videos.list` for the candidate ids to get maxres thumbnails +
   view counts, ranks by views, keeps the top 8 per style.
3. Downloads them as `trending-<videoId>.jpg`. Old `trending-*` files are
   removed first so the folder never bloats; hand-curated images (anything not
   prefixed `trending-`) are preserved.
4. Re-runs `extract-descriptors` (which guards against refusals /
   meta-commentary — bad output is dropped, not stored).
5. If `descriptors.json` changed, the workflow auto-commits and pushes back.

> Why per-style **search** and not the `chart=mostPopular` trending list:
> trending in JP/US is mostly music videos and movie trailers, and YouTube's
> coarse `categoryId` doesn't map to our styles — that fed off-style images
> into the vlog/tech buckets (Claude Vision then refused to extract a "cozy
> vlog" style from anime-MV thumbnails). Searching each style's own queries,
> ordered by views, yields on-style, proven-high-performing references.

To run the whole pipeline locally instead of waiting for cron:

```powershell
$env:YOUTUBE_API_KEY="..."
$env:ANTHROPIC_API_KEY="sk-ant-..."
npm run refresh-references
```

GitHub Actions secrets needed (Settings → Secrets and variables → Actions):
- `YOUTUBE_API_KEY` (already configured in Vercel; copy the same value here)
- `ANTHROPIC_API_KEY`

## Gitignore policy

Reference images themselves are `.gitignore`d (too heavy + may have
copyright concerns). The folders + `.gitkeep` markers + the resulting
`descriptors.json` ARE committed so the style cues ship with the code.
