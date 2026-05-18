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

// ---- Title wrapping ---------------------------------------------------------

function wrapTitle(title: string, targetCharsPerLine: number, maxLines: number): string[] {
  const lines: string[] = [];
  let remaining = title.trim();
  while (remaining.length > 0 && lines.length < maxLines) {
    if (remaining.length <= targetCharsPerLine || lines.length === maxLines - 1) {
      lines.push(remaining);
      break;
    }
    let breakAt = targetCharsPerLine;
    const slice = remaining.slice(0, targetCharsPerLine + 4);
    const punctMatch = slice.match(/^.{0,}[\s、。!?!?,.…・]/u);
    if (punctMatch && punctMatch[0].length >= targetCharsPerLine - 2) {
      breakAt = punctMatch[0].length;
    }
    lines.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }
  return lines;
}

// ---- Style definitions ------------------------------------------------------

export type ThumbnailStyle = 'vlog' | 'tech' | 'gaming' | 'editorial';

export const STYLE_DESCRIPTIONS: Record<ThumbnailStyle, string> = {
  vlog: 'Lifestyle / Vlog style — center serif title with sub-tag bars',
  tech: 'Tech / How-to style — left text, right subject',
  gaming: 'Gaming / Impact style — huge bottom title with red shadow',
  editorial: 'Editorial / Calm style — subtle serif title on lower bar',
};

const h = React.createElement;

function buildVlogElement(title: string, bgDataUrl: string): React.ReactElement {
  const lines = wrapTitle(title, 10, 2);
  const fontSize = lines.length === 1 ? 120 : 96;

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
          'linear-gradient(to bottom, rgba(0,0,0,0.45), rgba(0,0,0,0.10) 50%, rgba(0,0,0,0.55))',
      },
    }),
    h('div', {
      style: {
        position: 'absolute',
        top: 198,
        left: 240,
        width: 800,
        height: 2,
        background: 'rgba(255,255,255,0.9)',
      },
    }),
    h('div', {
      style: {
        position: 'absolute',
        top: 540,
        left: 240,
        width: 800,
        height: 2,
        background: 'rgba(255,255,255,0.9)',
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
          fontFamily: 'JpSerifBold',
          fontWeight: 700,
          fontSize,
          color: 'white',
          textAlign: 'center',
          textShadow:
            '0 0 12px rgba(0,0,0,0.85), 0 0 4px rgba(0,0,0,0.95), 4px 4px 0 rgba(0,0,0,0.6)',
          padding: '0 80px',
          lineHeight: 1.18,
        },
      },
      ...lines.map((line, i) =>
        h('div', { key: i, style: { display: 'flex' } }, line)
      )
    )
  );
}

function buildTechElement(title: string, bgDataUrl: string): React.ReactElement {
  const lines = wrapTitle(title, 9, 3);
  const fontSize = lines.length <= 2 ? 88 : 72;

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
  const lines = wrapTitle(title, 12, 2);
  const fontSize = lines.length === 1 ? 124 : 92;

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
          'linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,0) 50%, rgba(0,0,0,0.9))',
      },
    }),
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
          color: 'white',
          textAlign: 'center',
          padding: '0 40px',
          lineHeight: 1.05,
          transform: 'skewX(-6deg)',
          textShadow:
            '6px 6px 0 #c00000, 6px 6px 0 #c00000, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000',
        },
      },
      ...lines.map((line, i) =>
        h('div', { key: i, style: { display: 'flex' } }, line)
      )
    )
  );
}

function buildEditorialElement(title: string, bgDataUrl: string): React.ReactElement {
  const lines = wrapTitle(title, 14, 2);
  const fontSize = lines.length === 1 ? 80 : 60;
  const barHeight = 220;

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
        left: 0,
        right: 0,
        bottom: 0,
        height: barHeight,
        background: 'rgba(15,12,41,0.78)',
      },
    }),
    h(
      'div',
      {
        style: {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: barHeight,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'JpSerifBold',
          fontWeight: 700,
          fontSize,
          color: 'white',
          textAlign: 'center',
          padding: '0 60px',
          lineHeight: 1.25,
        },
      },
      ...lines.map((line, i) =>
        h('div', { key: i, style: { display: 'flex' } }, line)
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
    case 'editorial':
      return buildEditorialElement(title, bgDataUrl);
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

export const ALL_STYLES: ThumbnailStyle[] = ['vlog', 'tech', 'gaming', 'editorial'];

// ---- Quad grid (5th composite) ---------------------------------------------

function extractKeyword(title: string): string {
  // Split on common delimiters; keep the first meaningful chunk.
  const delimiters = /[|｜\-—–\/／:：「」『』\[\]【】()（）#＃]/;
  const parts = title
    .split(delimiters)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  let kw = (parts[0] || title).trim();
  if (kw.length > 16) kw = kw.slice(0, 16);
  return kw;
}

/**
 * 5th composite: 2x2 grid of the raw background (no text) with ONE big
 * centered keyword overlaid. Avoids the "same caption × 4" feel of the
 * previous version that tiled fully-composed thumbnails.
 */
export async function composeQuadGrid(
  backgroundImageBuffer: Buffer,
  title: string
): Promise<Buffer> {
  const fonts = await loadFonts();

  // One raw background, no text. Resize once, reuse for all 4 quadrants.
  const quadrant = await sharp(backgroundImageBuffer)
    .resize(640, 360, { fit: 'cover', position: 'center' })
    .png()
    .toBuffer();

  const gridBg = await sharp({
    create: {
      width: 1280,
      height: 720,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite([
      { input: quadrant, top: 0, left: 0 },
      { input: quadrant, top: 0, left: 640 },
      { input: quadrant, top: 360, left: 0 },
      { input: quadrant, top: 360, left: 640 },
    ])
    .png()
    .toBuffer();

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

