import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

// ---- Font loading (cached) --------------------------------------------------

let cachedFonts: { sansBlack: string; sansBold: string; serifBold: string } | null = null;

function loadFonts() {
  if (cachedFonts) return cachedFonts;

  const sansBlackPath = path.join(
    process.cwd(),
    'node_modules/@fontsource/noto-sans-jp/files/noto-sans-jp-japanese-900-normal.woff2'
  );
  const sansBoldPath = path.join(
    process.cwd(),
    'node_modules/@fontsource/noto-sans-jp/files/noto-sans-jp-japanese-700-normal.woff2'
  );
  const serifBoldPath = path.join(
    process.cwd(),
    'node_modules/@fontsource/noto-serif-jp/files/noto-serif-jp-japanese-700-normal.woff2'
  );

  cachedFonts = {
    sansBlack: fs.readFileSync(sansBlackPath).toString('base64'),
    sansBold: fs.readFileSync(sansBoldPath).toString('base64'),
    serifBold: fs.readFileSync(serifBoldPath).toString('base64'),
  };
  return cachedFonts;
}

// ---- Helpers ----------------------------------------------------------------

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!)
  );
}

/**
 * Break a Japanese title into up to `maxLines` lines so it roughly fits
 * within `targetCharsPerLine` characters per line. Simple greedy wrap.
 */
function wrapTitle(title: string, targetCharsPerLine: number, maxLines: number): string[] {
  const lines: string[] = [];
  let remaining = title.trim();
  while (remaining.length > 0 && lines.length < maxLines) {
    if (remaining.length <= targetCharsPerLine || lines.length === maxLines - 1) {
      lines.push(remaining);
      break;
    }
    // Try to break on a punctuation/space near the target index
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

function fontFaceCss(fonts: { sansBlack: string; sansBold: string; serifBold: string }): string {
  return `
    @font-face { font-family: 'JpSansBlack'; src: url(data:font/woff2;base64,${fonts.sansBlack}) format('woff2'); font-weight: 900; }
    @font-face { font-family: 'JpSansBold';  src: url(data:font/woff2;base64,${fonts.sansBold}) format('woff2'); font-weight: 700; }
    @font-face { font-family: 'JpSerifBold'; src: url(data:font/woff2;base64,${fonts.serifBold}) format('woff2'); font-weight: 700; }
  `;
}

// ---- Style definitions ------------------------------------------------------

export type ThumbnailStyle = 'vlog' | 'tech' | 'gaming' | 'editorial';

export const STYLE_DESCRIPTIONS: Record<ThumbnailStyle, string> = {
  vlog: 'Lifestyle / Vlog style — center serif title with sub-tag bars',
  tech: 'Tech / How-to style — left text, right subject',
  gaming: 'Gaming / Impact style — huge bottom title with red shadow',
  editorial: 'Editorial / Calm style — subtle serif title on lower bar',
};

function buildVlogSvg(title: string, fonts: ReturnType<typeof loadFonts>): string {
  const lines = wrapTitle(title, 10, 2);
  const fontSize = lines.length === 1 ? 120 : 100;
  const lineHeight = fontSize * 1.15;
  const totalHeight = lineHeight * lines.length;
  const startY = 360 - totalHeight / 2 + fontSize * 0.85;

  const lineTags = lines
    .map(
      (line, i) =>
        `<text x="640" y="${startY + i * lineHeight}" text-anchor="middle" font-family="JpSerifBold" font-size="${fontSize}" font-weight="700" fill="white" stroke="black" stroke-width="6" paint-order="stroke">${escapeXml(line)}</text>`
    )
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
    <defs><style>${fontFaceCss(fonts)}</style>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="rgba(0,0,0,0.35)"/>
        <stop offset="0.5" stop-color="rgba(0,0,0,0.15)"/>
        <stop offset="1" stop-color="rgba(0,0,0,0.45)"/>
      </linearGradient>
    </defs>
    <rect width="1280" height="720" fill="url(#bg)"/>
    <line x1="240" y1="200" x2="1040" y2="200" stroke="white" stroke-width="2" opacity="0.85"/>
    <line x1="240" y1="540" x2="1040" y2="540" stroke="white" stroke-width="2" opacity="0.85"/>
    ${lineTags}
  </svg>`;
}

function buildTechSvg(title: string, fonts: ReturnType<typeof loadFonts>): string {
  const lines = wrapTitle(title, 10, 3);
  const fontSize = lines.length <= 2 ? 92 : 76;
  const lineHeight = fontSize * 1.1;
  const totalHeight = lineHeight * lines.length;
  const startY = 360 - totalHeight / 2 + fontSize * 0.85;

  const lineTags = lines
    .map(
      (line, i) =>
        `<text x="60" y="${startY + i * lineHeight}" text-anchor="start" font-family="JpSansBlack" font-size="${fontSize}" font-weight="900" fill="white" stroke="black" stroke-width="10" paint-order="stroke">${escapeXml(line)}</text>`
    )
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
    <defs><style>${fontFaceCss(fonts)}</style>
      <linearGradient id="leftFade" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="rgba(0,0,0,0.65)"/>
        <stop offset="0.55" stop-color="rgba(0,0,0,0.25)"/>
        <stop offset="1" stop-color="rgba(0,0,0,0)"/>
      </linearGradient>
    </defs>
    <rect width="760" height="720" fill="url(#leftFade)"/>
    ${lineTags}
  </svg>`;
}

function buildGamingSvg(title: string, fonts: ReturnType<typeof loadFonts>): string {
  const lines = wrapTitle(title, 12, 2);
  const fontSize = lines.length === 1 ? 124 : 96;
  const lineHeight = fontSize * 1.05;
  const startY = 720 - 50 - (lines.length - 1) * lineHeight;

  const lineTags = lines
    .map(
      (line, i) =>
        `<text x="640" y="${startY + i * lineHeight}" text-anchor="middle" font-family="JpSansBlack" font-size="${fontSize}" font-weight="900" fill="white" stroke="#c00" stroke-width="10" paint-order="stroke" transform="skewX(-6)" transform-origin="640 ${startY + i * lineHeight}">${escapeXml(line)}</text>`
    )
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
    <defs><style>${fontFaceCss(fonts)}</style>
      <linearGradient id="bottomFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="rgba(0,0,0,0)"/>
        <stop offset="0.55" stop-color="rgba(0,0,0,0)"/>
        <stop offset="1" stop-color="rgba(0,0,0,0.85)"/>
      </linearGradient>
    </defs>
    <rect width="1280" height="720" fill="url(#bottomFade)"/>
    ${lineTags}
  </svg>`;
}

function buildEditorialSvg(title: string, fonts: ReturnType<typeof loadFonts>): string {
  const lines = wrapTitle(title, 14, 2);
  const fontSize = lines.length === 1 ? 80 : 64;
  const lineHeight = fontSize * 1.2;
  const totalHeight = lineHeight * lines.length;
  const barHeight = 220;
  const startY = 720 - barHeight + (barHeight - totalHeight) / 2 + fontSize * 0.85;

  const lineTags = lines
    .map(
      (line, i) =>
        `<text x="640" y="${startY + i * lineHeight}" text-anchor="middle" font-family="JpSerifBold" font-size="${fontSize}" font-weight="700" fill="white">${escapeXml(line)}</text>`
    )
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
    <defs><style>${fontFaceCss(fonts)}</style></defs>
    <rect x="0" y="${720 - barHeight}" width="1280" height="${barHeight}" fill="rgba(15,12,41,0.78)"/>
    ${lineTags}
  </svg>`;
}

// ---- Main compose function --------------------------------------------------

export async function composeThumbnail(
  backgroundImageBuffer: Buffer,
  title: string,
  style: ThumbnailStyle
): Promise<Buffer> {
  const fonts = loadFonts();

  let svg: string;
  switch (style) {
    case 'vlog':
      svg = buildVlogSvg(title, fonts);
      break;
    case 'tech':
      svg = buildTechSvg(title, fonts);
      break;
    case 'gaming':
      svg = buildGamingSvg(title, fonts);
      break;
    case 'editorial':
      svg = buildEditorialSvg(title, fonts);
      break;
  }

  return await sharp(backgroundImageBuffer)
    .resize(1280, 720, { fit: 'cover', position: 'center' })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png({ quality: 92, compressionLevel: 8 })
    .toBuffer();
}

export const ALL_STYLES: ThumbnailStyle[] = ['vlog', 'tech', 'gaming', 'editorial'];
