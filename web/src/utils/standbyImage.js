import { t } from '@lingui/core/macro';
import { canvasToDeviceImage, deviceImageToCanvas, drawToCanvas } from './profileImage.js';

// Standby background: same device format as profile images (LVGL header + RGB565), sized for the full 480x480 panel
// and stored in the display's internal flash, so it works without an SD card.
export const STANDBY_IMAGE_SIZE = 480;
const IMAGE_URL = '/api/standby/image';

export async function fetchStandbyImagePreview(rev) {
  const response = await fetch(`${IMAGE_URL}?rev=${encodeURIComponent(rev ?? 0)}`, {
    cache: 'no-store',
  });
  if (!response.ok) return null;
  return deviceImageToCanvas(await response.arrayBuffer(), STANDBY_IMAGE_SIZE).toDataURL();
}

// Returns a preview data URL of what was uploaded.
export async function uploadStandbyImage(blob) {
  const canvas = await drawToCanvas(blob, STANDBY_IMAGE_SIZE);
  const response = await fetch(IMAGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    // A File, because the app's native HTTP bridge carries binary only for File bodies.
    body: new File([canvasToDeviceImage(canvas, STANDBY_IMAGE_SIZE)], 'standby.bin', {
      type: 'application/octet-stream',
    }),
  });
  if (!response.ok) throw new Error((await response.text()) || t`Upload failed`);
  return canvas.toDataURL();
}

export async function deleteStandbyImage() {
  const response = await fetch(IMAGE_URL, { method: 'DELETE' });
  if (!response.ok) throw new Error((await response.text()) || t`Could not remove image`);
}

// Custom standby logo: trimmed and fitted into 400x160 here, stored on the display as either alpha-only (tinted with
// the theme colour, like the stock logo) or RGB565 + alpha (kept in its own colours). See StandbyImage.h.
export const LOGO_MAX_W = 400;
export const LOGO_MAX_H = 160;
export const LOGO_IMAGE_TYPES = [
  'image/png',
  'image/svg+xml',
  'image/jpeg',
  'image/webp',
  'image/bmp',
];
const LOGO_URL = '/api/standby/logo';
const CF_TRUE_COLOR_ALPHA = 5;
const CF_ALPHA_8BIT = 14;
const header = (cf, w, h) => cf | (w << 10) | (h << 21);

function loadImageElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(t`Could not read this image.`));
    };
    img.src = url;
  });
}

const MAX_CANVAS = 4096; // per side, keeps huge or degenerate inputs from exhausting memory

function drawPixels(img, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.min(MAX_CANVAS, Math.round(width)));
  canvas.height = Math.max(1, Math.min(MAX_CANVAS, Math.round(height)));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  keyOutBackground(data);
  return data;
}

// The visible part of `image`, resampled to scale.
function cropAndScale(image, box, scale) {
  const source = document.createElement('canvas');
  source.width = image.width;
  source.height = image.height;
  source.getContext('2d').putImageData(image, 0, 0);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(box.w * scale));
  canvas.height = Math.max(1, Math.round(box.h * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, box.x0, box.y0, box.w, box.h, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// The logo's visible pixels at their final size (at most 400x160), with a usable alpha channel. Padding is trimmed
// before fitting, so it doesn't shrink the logo. A logo on a solid background (JPEG, or a PNG without transparency)
// gets that background, sampled from the corners, keyed out. Bitmaps are never enlarged; vectors are drawn at size.
async function rasterizeLogo(blob) {
  const isSvg = blob.type === 'image/svg+xml';
  const { img, url } = await loadImageElement(blob);
  try {
    const naturalW = img.naturalWidth || LOGO_MAX_W;
    const naturalH = img.naturalHeight || LOGO_MAX_H;
    const fitBox = box => Math.min(LOGO_MAX_W / box.w, LOGO_MAX_H / box.h);
    // Bitmaps are trimmed at their own resolution; vectors at twice the box, enough to find the edges.
    let work = isSvg
      ? Math.min((LOGO_MAX_W * 2) / naturalW, (LOGO_MAX_H * 2) / naturalH)
      : Math.min(1, MAX_CANVAS / Math.max(naturalW, naturalH));
    let image = drawPixels(img, naturalW * work, naturalH * work);
    let box = trim(image);
    if (isSvg && fitBox(box) > 1) {
      // Mostly padding: draw the vector again large enough that its content fills the box.
      work *= fitBox(box);
      image = drawPixels(img, naturalW * work, naturalH * work);
      box = trim(image);
    }
    return cropAndScale(image, box, Math.min(1, fitBox(box)));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function keyOutBackground({ data, width, height }) {
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) transparent++;
  if (transparent > (width * height) / 100) return; // already has transparency: trust it
  const corners = [0, width - 1, (height - 1) * width, height * width - 1].map(p => p * 4);
  const bg = [0, 1, 2].map(c => corners.reduce((sum, p) => sum + data[p + c], 0) / corners.length);
  const distance = i => Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);
  let max = 0;
  for (let i = 0; i < data.length; i += 4) max = Math.max(max, distance(i));
  if (max < 30) return; // a flat image: nothing to key out
  for (let i = 0; i < data.length; i += 4) {
    data[i + 3] = Math.min(255, Math.round((distance(i) / max) * 255 * 1.5));
  }
}

// Bounding box of the visible pixels, so the logo is centred by its content rather than its padding.
function trim({ data, width, height }) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
  }
  if (x1 < 0) throw new Error(t`The logo is empty or fully transparent.`);
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Device file + a preview image (white for tinted logos: the preview colours it per theme).
function encodeLogo(image, box, tint) {
  const { data, width } = image;
  const { x0, y0, w, h } = box;
  const bpp = tint ? 1 : 3;
  const out = new Uint8Array(4 + w * h * bpp);
  new DataView(out.buffer).setUint32(
    0,
    header(tint ? CF_ALPHA_8BIT : CF_TRUE_COLOR_ALPHA, w, h),
    true,
  );
  const preview = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * width + (x0 + x)) * 4;
      const d = y * w + x;
      const [r, g, b, a] = [data[s], data[s + 1], data[s + 2], data[s + 3]];
      if (tint) {
        out[4 + d] = a;
        preview.data.set([255, 255, 255, a], d * 4);
      } else {
        const rgb565 = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
        out[4 + d * 3] = rgb565 & 0xff;
        out[4 + d * 3 + 1] = rgb565 >> 8;
        out[4 + d * 3 + 2] = a;
        preview.data.set([r, g, b, a], d * 4);
      }
    }
  }
  return { buffer: out.buffer, preview: imageDataToUrl(preview), w, h, tint };
}

function imageDataToUrl(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return canvas.toDataURL();
}

// Converts and uploads a logo file; returns { preview, w, h, tint } for the live preview.
export async function uploadStandbyLogo(blob, tint) {
  const image = await rasterizeLogo(blob);
  const logo = encodeLogo(image, { x0: 0, y0: 0, w: image.width, h: image.height }, tint);
  const response = await fetch(LOGO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new File([logo.buffer], 'logo.bin', { type: 'application/octet-stream' }),
  });
  if (!response.ok) throw new Error((await response.text()) || t`Upload failed`);
  return { preview: logo.preview, w: logo.w, h: logo.h, tint: logo.tint };
}

// The logo stored on the display, decoded for the preview; null when there is none.
export async function fetchStandbyLogo(rev) {
  const response = await fetch(`${LOGO_URL}?rev=${encodeURIComponent(rev ?? 0)}`, {
    cache: 'no-store',
  });
  if (!response.ok) return null;
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < 4) return null;
  const view = new DataView(buffer);
  const raw = view.getUint32(0, true);
  const cf = raw & 0x1f;
  const w = (raw >> 10) & 0x7ff;
  const h = (raw >> 21) & 0x7ff;
  const tint = cf === CF_ALPHA_8BIT;
  if ((!tint && cf !== CF_TRUE_COLOR_ALPHA) || buffer.byteLength !== 4 + w * h * (tint ? 1 : 3))
    return null;
  const bytes = new Uint8Array(buffer, 4);
  const preview = new ImageData(w, h);
  for (let d = 0; d < w * h; d++) {
    if (tint) {
      preview.data.set([255, 255, 255, bytes[d]], d * 4);
    } else {
      const v = bytes[d * 3] | (bytes[d * 3 + 1] << 8);
      const r = (((v >> 11) & 0x1f) * 255) / 31;
      const g = (((v >> 5) & 0x3f) * 255) / 63;
      const b = ((v & 0x1f) * 255) / 31;
      preview.data.set([r, g, b, bytes[d * 3 + 2]], d * 4);
    }
  }
  return { preview: imageDataToUrl(preview), w, h, tint };
}

export async function deleteStandbyLogo() {
  const response = await fetch(LOGO_URL, { method: 'DELETE' });
  if (!response.ok) throw new Error((await response.text()) || t`Could not remove logo`);
}
