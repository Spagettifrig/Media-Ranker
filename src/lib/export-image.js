/**
 * Draws the whole ranking to a canvas and hands back PNG/JPEG bytes.
 *
 * This is done by hand rather than by screenshotting the DOM: the export then
 * owns its own layout, so it is identical whatever the window size, whatever
 * is scrolled into view, and whichever theme is on screen.
 */
import { scoreBand } from './score.js';
import { formatDate, formatHours } from './stats.js';
import { genreLabels, modeLabels } from './media.js';

const W = 1100;
const PAD = 44;
const ROW_H = 84;
const HEADER_H = 150;
const FOOTER_H = 58;
const THUMB_W = 48;
const THUMB_H = 64;
const SCALE = 2; // Draw at 2x so text stays sharp when the image is zoomed.

const FONT = '"Segoe UI", system-ui, -apple-system, Arial, sans-serif';

export const EXPORT_FORMATS = [
  { key: 'png', label: 'PNG', mime: 'image/png', ext: 'png' },
  { key: 'jpeg', label: 'JPEG', mime: 'image/jpeg', ext: 'jpg' },
];

const PALETTES = {
  dark: {
    bg: '#0e1013',
    panel: '#16191f',
    stripe: '#12151a',
    line: '#262c37',
    text: '#e7eaf0',
    dim: '#9aa3b4',
    faint: '#6b7383',
  },
  light: {
    bg: '#f6f7fa',
    panel: '#ffffff',
    stripe: '#f0f2f6',
    line: '#dde1e9',
    text: '#171a20',
    dim: '#4d5666',
    faint: '#79808f',
  },
};

/**
 * Load one stored cover, or null if it cannot be read.
 *
 * The bytes come back from the main process as a data: URL rather than over
 * the gameimg: scheme - Chromium will not apply `crossOrigin` to a custom
 * scheme, so a gameimg: image taints the canvas and blocks toBlob().
 */
async function loadCover(name) {
  if (!name) return null;
  const dataUrl = await window.api.readImage(name);
  if (!dataUrl) return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** object-fit: cover, done by hand. */
function drawCover(ctx, img, x, y, w, h, radius) {
  ctx.save();
  roundRect(ctx, x, y, w, h, radius);
  ctx.clip();
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}...`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}...`;
}

/**
 * @returns {Promise<{ blob: Blob, width: number, height: number }>}
 */
export async function renderRankingImage({ items, config, format = 'png', theme = 'dark', subtitle }) {
  const palette = PALETTES[theme === 'light' ? 'light' : 'dark'];
  const spec = EXPORT_FORMATS.find((f) => f.key === format) ?? EXPORT_FORMATS[0];

  const height = HEADER_H + Math.max(1, items.length) * ROW_H + FOOTER_H;
  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = 'middle';

  /* Background. JPEG has no alpha, so this fill is what stops it going black. */
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, W, height);

  /* ---- header ---- */
  ctx.fillStyle = palette.text;
  ctx.font = `700 30px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(config.title, PAD, 52);

  ctx.fillStyle = palette.faint;
  ctx.font = `400 14px ${FONT}`;
  const countLine = `${items.length} ${items.length === 1 ? config.item : config.items} ranked`;
  ctx.fillText(subtitle ? `${countLine} · ${subtitle}` : countLine, PAD, 80);

  ctx.textAlign = 'right';
  ctx.fillText(
    new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
    W - PAD,
    52,
  );

  /* Column geometry, measured in from the right edge. */
  const dateRight = W - PAD;
  const hoursRight = dateRight - 130;
  const scoreCx = hoursRight - 112;
  const titleX = PAD + 58 + THUMB_W + 18;
  const titleMax = scoreCx - 34 - titleX;

  const headRowY = HEADER_H - 22;
  ctx.font = `650 11px ${FONT}`;
  ctx.fillStyle = palette.faint;
  ctx.textAlign = 'left';
  ctx.fillText('#', PAD + 8, headRowY);
  ctx.fillText(config.Item.toUpperCase(), titleX, headRowY);
  ctx.textAlign = 'center';
  ctx.fillText('SCORE', scoreCx, headRowY);
  ctx.textAlign = 'right';
  ctx.fillText(config.hours.label.toUpperCase(), hoursRight, headRowY);
  ctx.fillText(config.date.label.toUpperCase(), dateRight, headRowY);

  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, HEADER_H - 8.5);
  ctx.lineTo(W - PAD, HEADER_H - 8.5);
  ctx.stroke();

  if (items.length === 0) {
    ctx.fillStyle = palette.faint;
    ctx.font = `400 15px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('Nothing to export yet.', W / 2, HEADER_H + ROW_H / 2);
  }

  /* Cover art is fetched up front so the rows can be drawn in one pass. */
  const covers = await Promise.all(items.map((item) => loadCover(item.mainImage)));

  /* ---- rows ---- */
  items.forEach((item, index) => {
    const top = HEADER_H + index * ROW_H;
    const mid = top + ROW_H / 2;

    if (index % 2 === 0) {
      ctx.fillStyle = palette.stripe;
      roundRect(ctx, PAD - 12, top + 4, W - (PAD - 12) * 2, ROW_H - 8, 12);
      ctx.fill();
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = palette.faint;
    ctx.font = `700 15px ${FONT}`;
    ctx.fillText(String(index + 1), PAD + 4, mid);

    const thumbX = PAD + 58;
    const thumbY = mid - THUMB_H / 2;
    const cover = covers[index];
    if (cover) {
      drawCover(ctx, cover, thumbX, thumbY, THUMB_W, THUMB_H, 8);
    } else {
      ctx.fillStyle = palette.panel;
      roundRect(ctx, thumbX, thumbY, THUMB_W, THUMB_H, 8);
      ctx.fill();
      ctx.strokeStyle = palette.line;
      ctx.stroke();
    }

    const tags = [
      ...genreLabels(config, item.genres),
      ...modeLabels(config, item.modes),
    ];

    ctx.fillStyle = palette.text;
    ctx.font = `600 17px ${FONT}`;
    ctx.fillText(ellipsize(ctx, item.title, titleMax), titleX, tags.length ? mid - 10 : mid);

    if (tags.length > 0) {
      ctx.fillStyle = palette.faint;
      ctx.font = `400 12.5px ${FONT}`;
      ctx.fillText(ellipsize(ctx, tags.join(' · '), titleMax), titleX, mid + 12);
    }

    const band = scoreBand(item.overallScore);
    ctx.fillStyle = band.color;
    ctx.beginPath();
    ctx.arc(scoreCx, mid, 21, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = band.ink;
    ctx.font = `700 15px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(item.overallScore), scoreCx, mid + 0.5);

    ctx.textAlign = 'right';
    ctx.fillStyle = palette.dim;
    ctx.font = `500 14px ${FONT}`;
    ctx.fillText(formatHours(item.hoursPlayed), hoursRight, mid);
    ctx.fillText(formatDate(item.firstPlayed), dateRight, mid);
  });

  /* ---- footer ---- */
  ctx.textAlign = 'center';
  ctx.fillStyle = palette.faint;
  ctx.font = `400 12px ${FONT}`;
  ctx.fillText(`${config.title} · exported ranking`, W / 2, height - FOOTER_H / 2);

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, spec.mime, spec.key === 'jpeg' ? 0.94 : undefined),
  );
  if (!blob) throw new Error('The ranking image could not be encoded.');
  return { blob, width: canvas.width, height: canvas.height, ext: spec.ext };
}

/** Build the filename the save dialog opens with. */
export function exportFileName(config, ext) {
  const stamp = new Date().toISOString().slice(0, 10);
  return `${config.title.toLowerCase().replace(/\s+/g, '-')}-${stamp}.${ext}`;
}
