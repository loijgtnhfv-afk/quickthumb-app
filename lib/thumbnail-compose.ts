import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import React from 'react';
// @ts-expect-error - wawoff2 has no type definitions
import wawoff from 'wawoff2';

// ---- Font loading (cached) --------------------------------------------------

type Fonts = {
  sansBlack: Buffer;
  sansBold: Buffer;
  serifBold: Buffer;
};

let cachedFonts: Fonts | null = null;
let fontsLoadingPromise: Promise<Fonts> | null = null;

// wawoff2 is Emscripten WASM. Its decompress() returns a Uint8Array backed by
// the WASM heap. Doing several decompresses (or any operation that triggers
// WASM memory growth) DETACHES previously returned ArrayBuffers. So we must
// (1) run decompresses sequentially, and (2) copy each result into fresh
// Node Buffer memory immediately, BEFORE the next decompress.
async function decompressToBuffer(woff2: Buffer): Promise<Buffer> {
  const ttf = (await wawoff.decompress(woff2)) as Uint8Array;
  return Buffer.from(ttf); // Buffer.from(Uint8Array) copies
}

async function loadFonts(): Promise<Fonts> {
  if (cachedFonts) return cachedFonts;
  if (fontsLoadingPromise) return fontsLoadingPromise;

  fontsLoadingPromise = (async () => {
    const root = process.cwd();
    const sansBlackPath = path.join(
      root,
      'node_modules/@fontsource/noto-sans-jp/files/noto-sans-jp-japanese-900-normal.woff2'
    );
    const sansBoldPath = path.join(
      root,
      'node_modules/@fontsource/noto-sans-jp/files/noto-sans-jp-japanese-700-normal.woff2'
    );
    const serifBoldPath = path.join(
      root,
      'node_modules/@fontsource/noto-serif-jp/files/noto-serif-jp-japanese-700-normal.woff2'
    );

    const [sansBlackWoff2, sansBoldWoff2, serifBoldWoff2] = await Promise.all([
      fs.promises.readFile(sansBlackPath),
      fs.promises.readFile(sansBoldPath),
      fs.promises.readFile(serifBoldPath),
    ]);

    // Satori cannot read WOFF2 (Brotli-compressed). Decompress to TTF first.
    // Sequential + immediate copy to avoid WASM heap-growth detaching buffers.
    const sansBlack = await decompressToBuffer(sansBlackWoff2);
    const sansBold = await decompressToBuffer(sansBoldWoff2);
    const serifBold = await decompressToBuffer(serifBoldWoff2);

    cachedFonts = { sansBlack, sansBold, serifBold };
    return cachedFonts;
  })();
  return fontsLoadingPromise;
}

// ---- Title cleaning / headline extraction ----------------------------------

const YT_META_PARENS =
  /[\(\[][^\)\]]*(?:Official|Music\s*Video|Audio|Remaster(?:ed)?|HD|4K|8K|Lyrics?|MV|PV|Live|Trailer|Teaser|Visualizer|Edit)[^\)\]]*[\)\]]/gi;
const LAUGH_MARKERS = /\b(?:w{2,}|lol|lmao|haha+)\b|[笑草]{1,}/gi;

/**
 * Strip YouTube boilerplate and laughter markers from a title. Used for both
 * the Flux prompt and the visible overlay text, so neither shows "(4K Remaster)".
 */
export function cleanTitle(title: string): string {
  return title
    .replace(YT_META_PARENS, '')
    .replace(LAUGH_MARKERS, '')
    .replace(/\s+/g, ' ')
    .replace(/[　]+/g, '')
    .trim();
}

const TITLE_DELIMITERS = /[|｜\-—–\/／:：「」『』\[\]【】()（）#＃]/;

/**
 * Extract a short, readable headline from a noisy YouTube title.
 *
 * - Drops YouTube metadata (Official Video / 4K Remaster / Lyrics etc.)
 * - Drops laughter (www, lol, 笑, 草)
 * - "Artist - Song" → prefers the Song side when it fits
 * - Japanese clickbait with 【tag】『chunk』 → joins the first 2-3 chunks
 * - Falls back to a word-boundary trim if still too long
 *
 * This is intentionally aggressive: thumbnails are unreadable when the full
 * 60-char title is jammed in. Short and punchy beats accurate-but-cluttered.
 */
export function extractDisplayTitle(title: string, maxChars: number = 24): string {
  const cleaned = cleanTitle(title);
  if (!cleaned) return title.slice(0, maxChars);

  const parts = cleaned
    .split(TITLE_DELIMITERS)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // "Artist - Song" special case
  if (parts.length === 2) {
    const [a, b] = parts;
    if (b.length <= maxChars && b.length >= 4) return b;
    if (a.length <= maxChars && a.length >= 4) return a;
  }

  // No delimiters: just trim to a word/particle boundary
  if (parts.length <= 1) {
    return truncateAtBoundary(cleaned, maxChars);
  }

  // Accumulate parts up to maxChars
  let result = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const candidate = result + ' ' + parts[i];
    if (candidate.length > maxChars) break;
    result = candidate;
  }
  if (result.length > maxChars) {
    result = truncateAtBoundary(result, maxChars);
  }
  return result;
}

function truncateAtBoundary(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  // Prefer the latest space, ASCII punctuation, or Japanese particle
  const candidates = [
    cut.lastIndexOf(' '),
    cut.lastIndexOf('・'),
    cut.lastIndexOf(','),
    cut.lastIndexOf('、'),
  ];
  const best = Math.max(...candidates);
  if (best > maxChars * 0.5) return cut.slice(0, best).trim();
  return cut.trim();
}

// ---- Title wrapping ---------------------------------------------------------

// Characters we should NOT leave dangling at the end of a line (opening marks),
// or NOT push to the start of a line (closing marks). For Satori we keep the
// rules simple — Japanese kinsoku.
const NO_START = '）)」』】]》。、,.…！？!?・';
const NO_END = '（(「『【[《';
const BREAK_CHARS = ' 　、。!?!?,.…・';

// For 2-line wraps, find the break index closest to the middle of the string
// — produces balanced lines like ["alone in NEW", "YORK CITY"] instead of
// ["alone in NEW YORK", "CITY"]. Returns null if no safe break exists.
function findBalancedSplit(s: string): [string, string] | null {
  const mid = s.length / 2;
  let bestIdx = -1;
  let bestDist = Infinity;

  for (let i = 1; i < s.length; i++) {
    if (!BREAK_CHARS.includes(s[i - 1])) continue;
    if (NO_START.includes(s[i])) continue;
    if (NO_END.includes(s[i - 1])) continue;
    const dist = Math.abs(i - mid);
    // <= so later (rightward) ties win, giving the second line a fair share.
    if (dist <= bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  const left = s.slice(0, bestIdx).trim();
  const right = s.slice(bestIdx).trim();
  if (!left || !right) return null;
  return [left, right];
}

function wrapTitle(title: string, targetCharsPerLine: number, maxLines: number): string[] {
  const trimmed = title.trim();

  // For 2-line wraps where the title fits comfortably in two lines, prefer a
  // balanced split over the original greedy left-to-right break. Avoids
  // "alone in NEW YORK / CITY" with just one word on line 2.
  if (
    maxLines === 2 &&
    trimmed.length > targetCharsPerLine * 1.25 &&
    trimmed.length <= targetCharsPerLine * 2.4
  ) {
    const balanced = findBalancedSplit(trimmed);
    if (balanced) return balanced;
  }

  const lines: string[] = [];
  let remaining = trimmed;
  while (remaining.length > 0 && lines.length < maxLines) {
    if (remaining.length <= targetCharsPerLine || lines.length === maxLines - 1) {
      lines.push(remaining);
      break;
    }
    let breakAt = targetCharsPerLine;

    // Prefer to break at a space/punctuation near the target.
    const slice = remaining.slice(0, targetCharsPerLine + 4);
    const punctMatch = slice.match(/^.{0,}[\s、。!?!?,.…・]/u);
    if (punctMatch && punctMatch[0].length >= targetCharsPerLine - 2) {
      breakAt = punctMatch[0].length;
    }

    // Don't break right BEFORE a "no-start" char (e.g., a closing bracket): pull
    // it onto the previous line.
    while (breakAt < remaining.length && NO_START.includes(remaining[breakAt])) {
      breakAt++;
    }
    // Don't leave an opening bracket dangling at the end of a line: push it
    // to the next line.
    while (breakAt > 1 && NO_END.includes(remaining[breakAt - 1])) {
      breakAt--;
    }

    lines.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }
  return lines;
}

// ---- Style definitions ------------------------------------------------------

export type ThumbnailStyle = 'vlog' | 'tech' | 'gaming' | 'magazine';

export const STYLE_DESCRIPTIONS: Record<ThumbnailStyle, string> = {
  vlog: 'Lifestyle / Vlog style — center serif title with sub-tag bars',
  tech: 'Tech / How-to style — left text, right subject',
  gaming: 'Gaming / Impact style — huge bottom title with red shadow',
  magazine: 'Magazine cover — top kicker + big serif display title on a hero photo',
};

const h = React.createElement;

function buildVlogElement(title: string, bgDataUrl: string): React.ReactElement {
  // Modern vlog: small white "VLOG" pill kicker, then a big bold sans title.
  // Replaces the old thin-keyline serif look (felt weak per user feedback).
  const lines = wrapTitle(title, 11, 2);
  const fontSize = lines.length === 1 ? 112 : 88;

  return h(
    'div',
    {
      style: {
        display: 'flex',
        width: '100%',
        height: '100%',
        position: 'relative',
      },
    },
    h('img', {
      src: bgDataUrl,
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
      },
    }),
    h('div', {
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background:
          'linear-gradient(to bottom, rgba(0,0,0,0.45), rgba(0,0,0,0.12) 50%, rgba(0,0,0,0.55))',
      },
    }),
    h(
      'div',
      {
        style: {
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 80px',
        },
      },
      // White rounded pill kicker (think "Daily Vlog" badge).
      h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            background: 'white',
            color: '#0f0c29',
            padding: '10px 26px',
            borderRadius: 999,
            fontFamily: 'JpSansBlack',
            fontWeight: 900,
            fontSize: 26,
            letterSpacing: '0.22em',
            marginBottom: 28,
          },
        },
        'VLOG'
      ),
      // Big sans title, centered.
      h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            fontFamily: 'JpSansBlack',
            fontWeight: 900,
            fontSize,
            color: 'white',
            textAlign: 'center',
            lineHeight: 1.12,
            textShadow:
              '0 0 14px rgba(0,0,0,0.75), 0 0 4px rgba(0,0,0,0.9), 4px 4px 0 rgba(0,0,0,0.45)',
          },
        },
        ...lines.map((line, i) =>
          h('div', { key: i, style: { display: 'flex' } }, line)
        )
      )
    )
  );
}

function buildTechElement(title: string, bgDataUrl: string): React.ReactElement {
  const lines = wrapTitle(title, 11, 2);
  const fontSize = lines.length === 1 ? 104 : 84;

  return h(
    'div',
    {
      style: {
        display: 'flex',
        width: '100%',
        height: '100%',
        position: 'relative',
      },
    },
    h('img', {
      src: bgDataUrl,
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
      },
    }),
    h('div', {
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: 800,
        height: '100%',
        background:
          'linear-gradient(to right, rgba(0,0,0,0.85), rgba(0,0,0,0.5) 60%, rgba(0,0,0,0))',
      },
    }),
    h(
      'div',
      {
        style: {
          position: 'absolute',
          top: 0,
          left: 0,
          width: 760,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'center',
          fontFamily: 'JpSansBlack',
          fontWeight: 900,
          fontSize,
          color: 'white',
          padding: '0 50px',
          lineHeight: 1.12,
          textShadow:
            '0 0 0 #000, 4px 4px 0 #000, -4px -4px 0 #000, 4px -4px 0 #000, -4px 4px 0 #000, 4px 0 0 #000, -4px 0 0 #000, 0 4px 0 #000, 0 -4px 0 #000',
        },
      },
      ...lines.map((line, i) =>
        h('div', { key: i, style: { display: 'flex' } }, line)
      )
    )
  );
}

function buildGamingElement(title: string, bgDataUrl: string): React.ReactElement {
  // Manga / comic-book vibe: bright yellow title with thick black outline and
  // a big red drop shadow. Top-right rotated red "ACTION!" stamp adds extra
  // comical energy without depending on user-supplied art.
  const lines = wrapTitle(title, 12, 2);
  const fontSize = lines.length === 1 ? 128 : 96;

  return h(
    'div',
    {
      style: {
        display: 'flex',
        width: '100%',
        height: '100%',
        position: 'relative',
      },
    },
    h('img', {
      src: bgDataUrl,
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
      },
    }),
    h('div', {
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background:
          'linear-gradient(to bottom, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.95) 100%)',
      },
    }),
    // Top-right red stamp — rotated, yellow text, black border.
    h(
      'div',
      {
        style: {
          position: 'absolute',
          top: 42,
          right: 48,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#dc2626',
          padding: '10px 22px',
          transform: 'rotate(-6deg)',
          border: '4px solid #000',
          fontFamily: 'JpSansBlack',
          fontWeight: 900,
          fontSize: 34,
          letterSpacing: '0.12em',
          color: '#fde047',
          textShadow: '2px 2px 0 #000',
        },
      },
      'ACTION!'
    ),
    // Big skewed bottom title — yellow over black outline, red drop shadow.
    h(
      'div',
      {
        style: {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 30,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'JpSansBlack',
          fontWeight: 900,
          fontSize,
          color: '#fde047',
          textAlign: 'center',
          padding: '0 40px',
          lineHeight: 1.05,
          transform: 'skewX(-6deg)',
          textShadow:
            '8px 8px 0 #c00000, -3px -3px 0 #000, 3px -3px 0 #000, -3px 3px 0 #000, 3px 3px 0 #000, 0 -3px 0 #000, 0 3px 0 #000, -3px 0 0 #000, 3px 0 0 #000',
        },
      },
      ...lines.map((line, i) =>
        h('div', { key: i, style: { display: 'flex' } }, line)
      )
    )
  );
}

function buildMagazineElement(title: string, bgDataUrl: string): React.ReactElement {
  // Magazine cover: top-left kicker + big serif display title, bottom-left
  // brand mark. Mimics print editorial covers (Vogue / TIME / GQ feel).
  const lines = wrapTitle(title, 10, 2);
  const fontSize = lines.length === 1 ? 100 : 80;

  return h(
    'div',
    {
      style: {
        display: 'flex',
        width: '100%',
        height: '100%',
        position: 'relative',
      },
    },
    h('img', {
      src: bgDataUrl,
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
      },
    }),
    // Soft diagonal darkening over the top-left quadrant so the type stays
    // legible no matter what the AI bg looks like.
    h('div', {
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '72%',
        height: '85%',
        background:
          'linear-gradient(135deg, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.28) 60%, rgba(0,0,0,0) 100%)',
      },
    }),
    // Kicker (red rule + small all-caps label)
    h(
      'div',
      {
        style: {
          position: 'absolute',
          top: 60,
          left: 60,
          display: 'flex',
          alignItems: 'center',
        },
      },
      h('div', {
        style: {
          width: 48,
          height: 4,
          background: '#e11d48',
          marginRight: 18,
        },
      }),
      h(
        'div',
        {
          style: {
            fontFamily: 'JpSansBlack',
            fontWeight: 900,
            fontSize: 28,
            color: 'white',
            letterSpacing: '0.24em',
          },
        },
        'FEATURE'
      )
    ),
    // Big serif display title, left-aligned, restricted to ~60% width so the
    // hero subject on the right still reads.
    h(
      'div',
      {
        style: {
          position: 'absolute',
          top: 150,
          left: 60,
          width: 780,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          fontFamily: 'JpSerifBold',
          fontWeight: 700,
          fontSize,
          color: 'white',
          lineHeight: 1.1,
          textShadow:
            '0 2px 10px rgba(0,0,0,0.7), 0 6px 22px rgba(0,0,0,0.55)',
        },
      },
      ...lines.map((line, i) =>
        h('div', { key: i, style: { display: 'flex' } }, line)
      )
    ),
    // Brand mark, bottom-left.
    h(
      'div',
      {
        style: {
          position: 'absolute',
          bottom: 42,
          left: 60,
          display: 'flex',
          alignItems: 'center',
        },
      },
      h(
        'div',
        {
          style: {
            fontFamily: 'JpSansBlack',
            fontWeight: 900,
            fontSize: 18,
            color: 'white',
            letterSpacing: '0.32em',
            opacity: 0.85,
          },
        },
        'QUICKTHUMB'
      )
    )
  );
}

function buildElement(
  style: ThumbnailStyle,
  title: string,
  bgDataUrl: string
): React.ReactElement {
  switch (style) {
    case 'vlog':
      return buildVlogElement(title, bgDataUrl);
    case 'tech':
      return buildTechElement(title, bgDataUrl);
    case 'gaming':
      return buildGamingElement(title, bgDataUrl);
    case 'magazine':
      return buildMagazineElement(title, bgDataUrl);
  }
}

// ---- Main compose function --------------------------------------------------

export async function composeThumbnail(
  backgroundImageBuffer: Buffer,
  title: string,
  style: ThumbnailStyle
): Promise<Buffer> {
  const fonts = await loadFonts();

  const bgPng = await sharp(backgroundImageBuffer)
    .resize(1280, 720, { fit: 'cover', position: 'center' })
    .png()
    .toBuffer();
  const bgDataUrl = `data:image/png;base64,${bgPng.toString('base64')}`;

  const element = buildElement(style, title, bgDataUrl);

  const svg = await satori(element, {
    width: 1280,
    height: 720,
    fonts: [
      { name: 'JpSansBlack', data: fonts.sansBlack, weight: 900, style: 'normal' },
      { name: 'JpSansBold', data: fonts.sansBold, weight: 700, style: 'normal' },
      { name: 'JpSerifBold', data: fonts.serifBold, weight: 700, style: 'normal' },
    ],
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1280 },
  });
  const pngData = resvg.render().asPng();

  return Buffer.from(pngData);
}

export const ALL_STYLES: ThumbnailStyle[] = ['vlog', 'tech', 'gaming', 'magazine'];

// ---- Quad grid (5th composite) ---------------------------------------------

function extractKeyword(title: string): string {
  // First clean YouTube metadata and laughter markers from the title.
  const cleaned = cleanTitle(title);
  const parts = cleaned
    .split(TITLE_DELIMITERS)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  let kw = (parts[0] || cleaned).trim();
  // Truncate at a word boundary, NEVER mid-letter. Cap at 20 so phrases
  // like "alone in NEW YORK" survive instead of cutting to "alone in NEW YOR".
  if (kw.length > 20) kw = truncateAtBoundary(kw, 20);
  return kw;
}

/**
 * Build a 2x2 tile of 4 different raw backgrounds (640x360 each).
 * Returned as a single 1280x720 PNG buffer. No text overlay.
 */
export async function composeQuadGridRaw(bgBuffers: Buffer[]): Promise<Buffer> {
  if (bgBuffers.length !== 4) {
    throw new Error(`composeQuadGridRaw expects exactly 4 buffers, got ${bgBuffers.length}`);
  }
  const tiles = await Promise.all(
    bgBuffers.map((buf) =>
      sharp(buf).resize(640, 360, { fit: 'cover', position: 'center' }).png().toBuffer()
    )
  );
  return await sharp({
    create: {
      width: 1280,
      height: 720,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite([
      { input: tiles[0], top: 0, left: 0 },
      { input: tiles[1], top: 0, left: 640 },
      { input: tiles[2], top: 360, left: 0 },
      { input: tiles[3], top: 360, left: 640 },
    ])
    .png({ quality: 92, compressionLevel: 8 })
    .toBuffer();
}

/**
 * 5th composite: 2x2 grid of 4 different raw backgrounds with ONE big
 * centered keyword overlaid. The 4 tiles come from the 4 style-specific
 * AI generations, so each quadrant shows a different scene.
 */
export async function composeQuadGrid(
  bgBuffers: Buffer[],
  title: string
): Promise<Buffer> {
  const fonts = await loadFonts();

  const gridBg = await composeQuadGridRaw(bgBuffers);
  const bgDataUrl = `data:image/png;base64,${gridBg.toString('base64')}`;

  const keyword = extractKeyword(title);
  const lines = wrapTitle(keyword, 8, 2);
  const fontSize = lines.length === 1 ? 156 : 112;

  const element = h(
    'div',
    {
      style: {
        display: 'flex',
        width: '100%',
        height: '100%',
        position: 'relative',
      },
    },
    h('img', {
      src: bgDataUrl,
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
      },
    }),
    h('div', {
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background:
          'radial-gradient(ellipse at center, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.15) 70%)',
      },
    }),
    h(
      'div',
      {
        style: {
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        },
      },
      h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'JpSansBlack',
            fontWeight: 900,
            fontSize,
            color: 'white',
            textAlign: 'center',
            lineHeight: 1.1,
            padding: '0 60px',
            textShadow:
              '0 0 24px rgba(0,0,0,0.95), 6px 6px 0 #000, -6px -6px 0 #000, 6px -6px 0 #000, -6px 6px 0 #000, 6px 0 0 #000, -6px 0 0 #000, 0 6px 0 #000, 0 -6px 0 #000',
          },
        },
        ...lines.map((line, i) =>
          h('div', { key: i, style: { display: 'flex' } }, line)
        )
      )
    )
  );

  const svg = await satori(element, {
    width: 1280,
    height: 720,
    fonts: [
      { name: 'JpSansBlack', data: fonts.sansBlack, weight: 900, style: 'normal' },
      { name: 'JpSansBold', data: fonts.sansBold, weight: 700, style: 'normal' },
      { name: 'JpSerifBold', data: fonts.serifBold, weight: 700, style: 'normal' },
    ],
  });

  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1280 } });
  return Buffer.from(resvg.render().asPng());
}

export const QUAD_GRID_DESCRIPTION =
  'Keyword spotlight — raw scene ×4 with one bold centered keyword';

// ---- Avatar overlay ---------------------------------------------------------

type AvatarPlacement = {
  diameter: number;
  // Top-left corner of the avatar disc (NOT the ring). Canvas is 1280x720.
  x: number;
  y: number;
  ringColor: string;
  ringWidth: number;
};

// Per-style placement: avoid the area each style uses for text.
// vlog      — text dead-center → avatar bottom-right
// tech      — left text panel  → avatar bottom-right (right side is photo subject anyway)
// gaming    — title bottom + ACTION! stamp top-right → avatar TOP-LEFT
// magazine  — title top-left, brand bottom-left → avatar middle-right
const AVATAR_PLACEMENTS: Record<ThumbnailStyle, AvatarPlacement> = {
  vlog: { diameter: 200, x: 1040, y: 480, ringColor: '#ffffff', ringWidth: 6 },
  tech: { diameter: 240, x: 970, y: 430, ringColor: '#22d3ee', ringWidth: 6 },
  gaming: { diameter: 220, x: 40, y: 40, ringColor: '#e11d48', ringWidth: 8 },
  magazine: { diameter: 200, x: 1040, y: 460, ringColor: '#e11d48', ringWidth: 6 },
};

export type AvatarKind = 'face' | 'logo';

/**
 * Overlay a circular avatar onto a composed thumbnail.
 *
 * - kind='face': avatar fills the disc (cover crop, smart attention). Best for
 *   profile photos — gives a strong, recognizable face on the thumbnail.
 * - kind='logo': avatar sits on a solid white disc, scaled to fit (contain).
 *   Logos / wordmarks never get cropped this way; reads as a clean badge.
 *
 * Render order: drop-shadow → colored ring → (white disc, logo only) →
 * circle-masked avatar. Placement and ring color vary per style.
 */
export async function compositeAvatar(
  thumbnailBuffer: Buffer,
  avatarBuffer: Buffer,
  style: ThumbnailStyle,
  kind: AvatarKind = 'face'
): Promise<Buffer> {
  const place = AVATAR_PLACEMENTS[style];
  const { diameter, x, y, ringColor, ringWidth } = place;
  const r = diameter / 2;

  let masked: Buffer;
  if (kind === 'logo') {
    // Logo: contain-fit on a transparent canvas (centered), then composite
    // onto a white disc inside the circular mask below. Inset by 12% so the
    // logo breathes inside the ring instead of touching it.
    const innerSize = Math.round(diameter * 0.76);
    const innerOffset = Math.round((diameter - innerSize) / 2);
    const fitted = await sharp(avatarBuffer)
      .resize(innerSize, innerSize, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    // White disc, full diameter.
    const whiteDiscSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}"><circle cx="${r}" cy="${r}" r="${r}" fill="white"/></svg>`
    );
    masked = await sharp(whiteDiscSvg)
      .png()
      .composite([{ input: fitted, top: innerOffset, left: innerOffset }])
      .png()
      .toBuffer();
  } else {
    // Face: cover crop with smart attention, then apply a circular alpha mask.
    const resized = await sharp(avatarBuffer)
      .resize(diameter, diameter, { fit: 'cover', position: 'attention' })
      .png()
      .toBuffer();
    const maskSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}"><circle cx="${r}" cy="${r}" r="${r}" fill="white"/></svg>`
    );
    masked = await sharp(resized)
      .composite([{ input: maskSvg, blend: 'dest-in' }])
      .png()
      .toBuffer();
  }

  // Solid colored ring (drawn under the avatar, slightly larger).
  const outerDiameter = diameter + ringWidth * 2;
  const outerR = outerDiameter / 2;
  const ringSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outerDiameter}" height="${outerDiameter}"><circle cx="${outerR}" cy="${outerR}" r="${outerR}" fill="${ringColor}"/></svg>`
  );
  const ring = await sharp(ringSvg).png().toBuffer();

  // Soft drop-shadow (blurred black disc, slightly offset down/right).
  const shadowPad = 14;
  const shadowDiameter = outerDiameter + shadowPad * 2;
  const shadowR = shadowDiameter / 2;
  const shadowSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${shadowDiameter}" height="${shadowDiameter}"><defs><filter id="b"><feGaussianBlur stdDeviation="6"/></filter></defs><circle cx="${shadowR}" cy="${shadowR}" r="${outerR}" fill="black" opacity="0.55" filter="url(#b)"/></svg>`
  );
  const shadow = await sharp(shadowSvg).png().toBuffer();

  // Clamp positions so we don't composite off-canvas (Sharp throws).
  const canvasW = 1280;
  const canvasH = 720;
  const ringX = Math.max(0, Math.min(canvasW - outerDiameter, x - ringWidth));
  const ringY = Math.max(0, Math.min(canvasH - outerDiameter, y - ringWidth));
  const avatarX = ringX + ringWidth;
  const avatarY = ringY + ringWidth;
  const shadowX = Math.max(0, Math.min(canvasW - shadowDiameter, ringX - shadowPad + 4));
  const shadowY = Math.max(0, Math.min(canvasH - shadowDiameter, ringY - shadowPad + 4));

  return await sharp(thumbnailBuffer)
    .composite([
      { input: shadow, left: shadowX, top: shadowY },
      { input: ring, left: ringX, top: ringY },
      { input: masked, left: avatarX, top: avatarY },
    ])
    .png()
    .toBuffer();
}

