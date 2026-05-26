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
- After the trending-thumbs auto-collector (planned) has dropped fresh
  examples

## Trending-thumbs auto-collector (planned)

A separate GitHub Actions cron will hit YouTube Data API daily for
`chart=mostPopular&regionCode=JP` (and `US`), classify each result by
`categoryId`, and drop the high-res thumbnail into the matching style
folder. That keeps the reference corpus self-updating.

## Gitignore policy

Reference images themselves are `.gitignore`d (too heavy + may have
copyright concerns). The folders + `.gitkeep` markers + the resulting
`descriptors.json` ARE committed so the style cues ship with the code.
