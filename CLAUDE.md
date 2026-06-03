# Quickthumb

AI-powered YouTube thumbnail generator SaaS. Paste a YouTube URL, get 5 styled thumbnail options in ~60 seconds.

## Status

- **Live**: https://quickthumb-app.vercel.app/ (custom domain quickthumb.app NOT wired up yet — apex + app. subdomain both fail to resolve as of 2026-06-03; `metadataBase` points at the Vercel origin until DNS is configured in Vercel)
- **GitHub**: github.com/loijgtnhfv-afk/quickthumb-app
- **Vercel**: sano-s-projects1/quickthumb-app
- **Stage**: Appeal pivot v2 LIVE (2026-06-03) — engine is Nano Banana Pro generating FINISHED thumbnails; the face comes from the user's OWN uploaded photo. Pre-launch (no Stripe yet). Free tier: 2 generations × 4 images.

## Owner

ヒヅル (loijgtnhfv@gmail.com). Solo founder, Japanese-speaking. Communicates casually in Japanese. Visual-first feedback (sends screenshots). Cost-conscious. Prefers brief replies and concrete next steps over long explanations.

**Target market**: BOTH US/global and Japan, not Japan-only despite the owner being Japanese-speaking. Decision on 2026-05-26 — UI is fully i18n'd (en + ja) so the same codebase serves both markets. See `i18n/request.ts`, `messages/`, and the EN/JA toggle in the page header. Don't strip the English path; don't default localization decisions to Japanese.

## Architecture (CURRENT — appeal pivot v2, 2026-06-03)

Paste a video URL + optionally upload your own face photo → 4 finished, styled thumbnails (hero + scene + baked-in hook text) in one pass.

1. `POST /api/generate` (auth + free-limit check).
2. `fetchVideoMetadata` (YouTube Data API) → title / description / channel.
3. `analyzeForThumbnail` (Claude Haiku) → an English scene topic + 2-4 word HOOKS in BOTH the title's language AND English (the JP + global localized variants).
4. **Face source = the user's OWN uploaded photo only** (`POST /api/upload-persona` → Supabase `thumbnails` bucket → public URL). No photo → faceless topical scene. A third party's face is NEVER baked in (legal: consent / right-of-publicity — see project memory).
5. **Engine = `lib/nbp.ts`** → Replicate `google/nano-banana-pro` (Gemini 3 Pro Image). For each of 4 `NBP_CONCEPTS` (face-surprise / jp-telop / global-clean[EN] / action) it builds a prompt that RESERVES a text zone (so the hero never occludes the hook), passes the face photo as `image_input` for identity preservation, generates 16:9 @2K, and pins the result to 1280×720 via sharp. Concepts run in parallel via `Promise.allSettled` (one concept failing — e.g. an NBP safety refusal — doesn't sink the batch).
6. Upload finished PNGs to Supabase Storage; return `thumbnails[]` (url / image_url / concept_key / prompt). UI renders whatever count survives.

**Cost ≈ $0.134/image × 4 ≈ $0.54/generation** (NBP 2K). Iterate prompts/concepts offline with `scripts/preview-nbp.ts` (needs only `REPLICATE_API_TOKEN`; output in `.preview-nbp/`).

> Everything below — the "A option" Flux-background + Satori-overlay pipeline, the 4 Satori "styles", the quad-grid 5th card, and the Satori/Flux/CJK "Critical Gotchas" — is **LEGACY (pre-2026-06-03)**. `lib/thumbnail-compose.ts` still exists but is no longer used by `/api/generate`. Kept for reference / possible reuse.

## Architecture — "A option" (LEGACY, pre-pivot — 4 style-specific bgs, parallel)

1. User pastes YouTube URL
2. Fetch video title + description via YouTube Data API v3
3. Replicate Flux Schnell generates **4 different** style-specific backgrounds in parallel (one per style, each $0.003 → $0.012 total). Prompts are tuned per style: warm lifestyle (vlog), cool tech editorial (tech), dramatic action (gaming), print-magazine cover (magazine).
4. Satori composes 4 styled thumbnails — each style overlays its Japanese text on **its own** AI background.
5. The 5th is a "keyword spotlight": Sharp tiles the 4 different raw backgrounds as a 2×2 grid, then Satori overlays ONE big centered keyword.
6. Each card also exposes the **raw image** (no overlay) for download — uploaded as `raw-{n}.png`. The 5th's raw is the same 2×2 tile minus the keyword.
7. All composed + raw PNGs uploaded to Supabase Storage; URLs (both `url` and `image_url`) returned to client.

**Cost per generation: $0.012** (4 AI images — compositions and tile/quad are pure JS/Sharp). Generation runs the 4 Flux calls in parallel + parallel compose + parallel upload, so wall-clock stays ~15-30s.

## Tech Stack

- **Next.js 15.3.5** App Router, Node runtime (NOT Edge — needs sharp)
- **TypeScript**
- **Supabase** — auth + Postgres + Storage
- **Replicate** — `black-forest-labs/flux-schnell` for background generation
- **Satori** + **@resvg/resvg-js** — React JSX → SVG → PNG, handles Japanese fonts as glyph paths
- **Sharp** — bg resize + 2×2 grid composite
- **wawoff2** — WOFF2 → TTF decompression (Satori can't read WOFF2)
- **@fontsource/noto-sans-jp** + **noto-serif-jp** — Japanese font files (WOFF2 only)

## Key Files

```
app/
  page.tsx                  — landing page (i18n via next-intl, EN/JA toggle)
  api/generate/route.ts     — main API endpoint (POST /api/generate) — CURRENT: Nano Banana Pro engine
  api/upload-persona/route.ts — uploads the user's own face photo (persona) → Supabase, returns URL
  api/locale/route.ts       — sets the NEXT_LOCALE cookie for i18n toggle
  auth/                     — Supabase Auth signup/login pages (i18n)
  layout.tsx                — root layout, server-resolves locale + NextIntlClientProvider
lib/
  nbp.ts                    — CURRENT engine: Nano Banana Pro finished-thumbnail generation + NBP_CONCEPTS
  thumbnail-compose.ts      — LEGACY Satori-based composition + composeQuadGrid + STYLE_KICKERS (unused by /api/generate)
  supabase/
    server.ts               — Supabase clients (createClient + createServiceClient)
middleware.ts               — auth middleware
next.config.mjs             — IMPORTANT: serverExternalPackages + outputFileTracingIncludes + next-intl plugin
i18n/request.ts             — locale resolution (cookie > Accept-Language > 'en') for next-intl
messages/
  en.json                   — English UI strings
  ja.json                   — Japanese UI strings
references/                 — reference thumbnails (gitignored images) + descriptors.json
  vlog/ tech/ gaming/ magazine/ — drop 5-15 reference images per style here
  descriptors.json          — auto-generated Vision-extracted style cues (committed)
scripts/
  extract-style-descriptors.ts  — `npm run extract-descriptors` (needs ANTHROPIC_API_KEY)
  collect-trending-thumbs.ts    — `npm run collect-trending` (needs YOUTUBE_API_KEY)
.github/workflows/
  refresh-descriptors.yml       — weekly cron: collect → extract → commit descriptors.json
package.json
```

## Database (Supabase)

Tables:
- `profiles` — id (FK auth.users), plan ('free' default), generations_used (int), generations_limit (5 default)
- `generations` — id, user_id, youtube_url, youtube_video_id, video_title, video_description, channel_title, prompts[], thumbnail_urls[], status ('processing'|'completed'|'failed'), error_message
- `usage_logs` — user_id, event_type, metadata (jsonb)

Storage bucket:
- `thumbnails` (public read) — path: `{user_id}/{generation_id}/thumb-{1-5}.png`

RLS is set up. Anon key can read own profile / generations / usage_logs only.

## Env Vars (already in Vercel)

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY` (server-only, used in API route to bypass RLS for inserts/uploads)
- `REPLICATE_API_TOKEN`
- `YOUTUBE_API_KEY`

To run locally: `vercel env pull .env.local --environment=production --yes` (after `vercel link`). Or copy manually from Vercel project settings → Environment Variables.

## Style Definitions

The 4 base styles (in `lib/thumbnail-compose.ts`):

1. **vlog** — White "VLOG" pill kicker + big centered sans title. Lifestyle vibe.
2. **tech** — Left-aligned heavy black sans with right-fade gradient panel. Tutorial vibe.
3. **gaming** — Yellow bottom title with thick black outline + red drop shadow, skewed -6°. Top-right rotated red "ACTION!" stamp. Manga / comic-book vibe.
4. **magazine** — Top-left red kicker rule + "FEATURE" label, big left-aligned serif display title, bottom-left "QUICKTHUMB" brand mark. Print-magazine cover vibe (Vogue / TIME / GQ feel). Replaced the older anime / editorial slot on 2026-05-25.

5th (auto-generated): **Keyword spotlight** — the raw text-free background tiled 2×2 (640×360 each) with ONE big keyword centered on top (extracted from the title via `extractKeyword()` in `lib/thumbnail-compose.ts`). White heavy sans on a radial vignette.

## Critical Gotchas (Learn from past pain)

### 1. Satori cannot read WOFF2
Satori only accepts TTF/OTF/WOFF (no WOFF2 — Brotli compression not supported). @fontsource ships only WOFF2. **Solution**: use `wawoff2.decompress()` to convert to TTF at startup, then pass the resulting Buffer to Satori.

### 2. wawoff2 is Emscripten WASM — watch out for ArrayBuffer detachment
`wawoff2.decompress()` returns a `Uint8Array` backed by the WASM heap. When you call it again (or anything that triggers WASM memory growth), the **previously returned buffers get DETACHED** and become unusable. Symptoms: `Cannot perform ArrayBuffer.prototype.slice on a detached ArrayBuffer`.

**Solution**: in `loadFonts()`, (1) run decompresses **sequentially** (NOT Promise.all), and (2) copy each result with `Buffer.from(uint8)` **immediately** after each decompress, before the next one runs. See `decompressToBuffer()` in `lib/thumbnail-compose.ts`.

### 3. Vercel native modules need serverExternalPackages
sharp, @resvg/resvg-js, and wawoff2 all use native binaries (.node files) or WASM. Webpack will try to bundle them and fail.

**Solution** (`next.config.mjs`):
```js
serverExternalPackages: ['sharp', '@resvg/resvg-js', 'wawoff2'],
```

### 4. Font files must be in the serverless bundle
By default, Vercel only includes files referenced through imports. The `.woff2` files inside `node_modules/@fontsource/...` are loaded via `fs.readFileSync()` at runtime, so Vercel's tracer misses them.

**Solution** (`next.config.mjs`):
```js
outputFileTracingIncludes: {
  '/api/generate': [
    './node_modules/@fontsource/noto-sans-jp/files/*.woff2',
    './node_modules/@fontsource/noto-serif-jp/files/*.woff2',
  ],
},
```

### 5. Replicate rate limit
When account balance is under $5, Replicate enforces `burst-1` — only one in-flight request at a time, and even sequential calls hit 429 sometimes. Above $5 it's effectively unlimited for our use case. User has ~$20 credit currently.

### 6. Vercel function timeout
Generation takes ~30-50s end-to-end. Route has `export const maxDuration = 60` to allow this. Free Vercel plan limit is 60s, Pro is 300s.

### 7. Flux scribbles fake Japanese characters when CJK appears in the prompt
Flux Schnell tries to render any CJK / kana / fullwidth glyphs it sees in the prompt as visible "Japanese-ish" text in the scene — on signs, T-shirts, posters, store fronts. The negative prompt alone does not stop this; the only reliable fix is to **not** put CJK in the prompt.

**Solution** (`app/api/generate/route.ts`): `stripCJK()` removes all CJK / fullwidth chars from title / channel / description before they're injected into the Flux prompt. If the title becomes shorter than 3 chars after stripping, the prompt uses the generic placeholder `"the subject"` instead. The description is dropped wholesale if it contained any CJK (partial-stripping leaves incoherent English). The negative prompt also explicitly lists `NO Japanese characters, NO kanji, NO hiragana, NO katakana, NO Asian text` etc. as backup.

## Decisions Already Made (don't re-litigate)

- **A option** chosen (4 separate AI images per style, parallel) over B option (1 shared bg). Cost moved from $0.003 → $0.012/gen, but each style now gets a visually appropriate scene. Replicate rate-limit OK above $5 balance.
- **Per-card "Image only" download** alongside the styled "Download" — gives the user the raw text-free AI image for further editing.
- **5th = keyword spotlight** with 4 different bgs tiled 2×2 + ONE central keyword (NOT the same caption ×4). User rejected the "tile composed thumbnails" version because it repeated the long title 4 times.
- **Satori + Resvg** instead of Sharp's internal resvg (Sharp's renderer ignores @font-face base64 data URLs — invisible text).
- **Free tier = 5 generations**, then 402 + upgrade prompt.
- **AI generates only background** (text-free). Japanese title is added via Satori overlay because Flux can't render CJK reliably.
- **Reference style descriptors are LIVE and auto-refreshing** (activated 2026-05-31). Collected via per-style YouTube **search** — NOT the trending chart, which was too noisy: trending + `categoryId` fed music/movie/Shorts into the vlog/tech buckets and Vision refused. Now `STYLE_QUERIES` per style, `order=viewCount`, `videoDuration=medium` (excludes vertical Shorts whose pillarboxed thumbs taught a wrong vertical/triptych look), gaming pinned to `videoCategoryId=20` (else "let's play"/viewCount pulls kids-edutainment like Sesame Street). Weekly GHA cron `refresh-descriptors.yml` (Mondays): collect → Claude Vision extract → auto-commit `descriptors.json` → Vercel redeploys. `descriptorClauseFor()` in `app/api/generate/route.ts` appends each style's descriptor to its Flux prompt; `extract-descriptors` drops Vision refusals via `isCleanDescriptor`. GH Actions secrets `YOUTUBE_API_KEY` + `ANTHROPIC_API_KEY` are set. Tune queries in `scripts/collect-trending-thumbs.ts`; details in `references/README.md`.

## Open Questions / Ideas Not Yet Decided

- Add a "simple editable template" style (5th editable slot for users who want to post-edit themselves)?
- Stripe Pro plan pricing — leaning toward $9-19/month for 150 generations but not finalized.
- Should we add OAuth to upload directly to user's YouTube channel? Big scope, defer.

## Next Tasks (prioritized)

1. **Verify the 2026-05-25 style refresh** — new magazine slot, new vlog pill kicker, gaming yellow + ACTION! stamp, and CJK stripping in the Flux prompt. Watch real generations and confirm Japanese videos no longer get scribbled fake characters.
2. **Persist raw URLs in DB** — `generations.thumbnail_urls` currently stores only composed URLs. Raw image URLs are only returned in the immediate API response; add a column if past-generation re-download is needed.
3. **Implement Stripe Pro plan** (subscription, webhook to update profiles.plan + generations_limit, customer portal).
4. **Launch** — X, Reddit (r/SideProject, r/SaaS), Indie Hackers, possibly Product Hunt.

## Workflow

- **Branch**: working directly on `main` (solo dev, fast iteration). Switch to feature branches once there are real users.
- **Deploy**: push to main → Vercel auto-deploys. No manual step.
- **Local dev**: `npm run dev` → http://localhost:3000. Need `.env.local` with the env vars listed above.
- **Test**: no automated tests yet. Manual: paste a YouTube URL, watch the 5 thumbnails generate.

## Tone for working with this user

- Default to Japanese unless they switch to English.
- Casual, conversational. They use spoken Japanese a lot ("みたいな", "って感じ", "やっぱ").
- Short answers preferred over long explanations.
- They learn by doing — show, don't lecture.
- They appreciate honest "this is hard / won't work" feedback. Don't sycophantically agree.
- When something works, just say so briefly and move to next thing. Don't over-celebrate.
