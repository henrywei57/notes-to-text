import { blocksToMarkdown } from './layout.js';
import { drawScaled, prepareForOcr } from './image.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js';
const NO_SPACE_LANGS = new Set(['chi_sim', 'chi_tra', 'jpn']);

let workerPromise = null;
let workerLang = null;
// The worker runs one job at a time, so a single progress hook is enough.
let onLog = null;

function getWorker(lang) {
  if (workerPromise && workerLang === lang) return workerPromise;
  if (workerPromise) {
    workerPromise.then((w) => w.terminate()).catch(() => {});
  }
  workerLang = lang;
  workerPromise = import(TESSERACT_URL)
    .then(({ default: Tesseract }) => Tesseract.createWorker(lang, 1, { logger: (m) => onLog?.(m) }))
    .catch((err) => {
      workerPromise = null;
      console.error(err);
      throw new Error("Couldn't load the OCR engine. Check your internet connection: it downloads once, then it's cached.");
    });
  return workerPromise;
}

export async function recognizeLocal(bitmap, { lang, enhance, onProgress }) {
  onLog = (m) => {
    if (m.status === 'recognizing text') onProgress(0.2 + m.progress * 0.8, 'Reading text');
    else onProgress(0.05 + (m.progress || 0) * 0.15, 'Loading OCR engine');
  };
  try {
    const worker = await getWorker(lang);
    // Tesseract reads small text far better once it's upscaled.
    const canvas = prepareForOcr(drawScaled(bitmap, { minLong: 2000, maxLong: 3600 }), { threshold: enhance });
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
    const joiner = NO_SPACE_LANGS.has(lang) ? '' : ' ';
    return data.blocks?.length ? blocksToMarkdown(data.blocks, { joiner }) : (data.text ?? '').trim();
  } finally {
    onLog = null;
  }
}
