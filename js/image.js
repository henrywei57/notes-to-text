export async function decodeImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Some formats (HEIC on Safari, for one) only decode through <img>.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return await createImageBitmap(img);
    } catch {
      throw new Error("Your browser can't open this image. Try saving it as a JPG or PNG first.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

export function drawScaled(bitmap, { minLong = 0, maxLong = Infinity } = {}) {
  const long = Math.max(bitmap.width, bitmap.height);
  let scale = 1;
  if (long < minLong) scale = minLong / long;
  if (long * scale > maxLong) scale = maxLong / long;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Transparent screenshots would otherwise turn black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Grayscale, flip light-on-dark slides, and optionally binarize photos.
export function prepareForOcr(canvas, { threshold = false } = {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width: w, height: h } = canvas;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const gray = new Uint8ClampedArray(n);
  let sum = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const g = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
    gray[i] = g;
    sum += g;
  }
  if (sum / n < 110) {
    for (let i = 0; i < n; i++) gray[i] = 255 - gray[i];
  }
  if (threshold) adaptiveThreshold(gray, w, h);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    d[p] = d[p + 1] = d[p + 2] = gray[i];
    d[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Bradley-Roth: compare each pixel with the mean of its neighbourhood, which
// strips out shadows and uneven lighting from phone photos of paper.
function adaptiveThreshold(gray, w, h) {
  const stride = w + 1;
  const integral = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  const r = Math.max(8, Math.round(Math.max(w, h) / 32));
  const t = 0.15;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const area = (x1 - x0) * (y1 - y0);
      const mean = (integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0]) / area;
      const g = gray[y * w + x];
      // The absolute gap keeps sensor noise in dark corners from turning into specks.
      gray[y * w + x] = g < mean * (1 - t) && mean - g > 25 ? 0 : 255;
    }
  }
}

// The API caps images at 5 MB, so step quality and size down until it fits.
export function toJpegBase64(bitmap) {
  for (const maxLong of [2400, 1800, 1400]) {
    const canvas = drawScaled(bitmap, { maxLong });
    for (const quality of [0.9, 0.8, 0.65]) {
      const data = canvas.toDataURL('image/jpeg', quality).split(',')[1];
      if (data.length < 4.8e6) return data;
    }
  }
  throw new Error('This image is too large to send, even after shrinking it.');
}
