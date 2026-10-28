const API = 'https://generativelanguage.googleapis.com/v1beta/models';

// Newest first. Google's busiest model is often overloaded, so the others are
// there to fall back on.
const FREE_CHAIN = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'];

export const GEMINI_MODELS = [
  { id: 'auto', label: 'Best free model (skips busy ones)', chain: FREE_CHAIN },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon (most accurate, needs billing)', chain: ['gemini-4-argon', ...FREE_CHAIN] },
];

const NAMES = {
  'gemini-4-argon': '4 Argon',
  'gemini-3.8-flash': '3.8 Flash',
  'gemini-3.6-flash': '3.6 Flash',
  'gemini-3.5-flash': '3.5 Flash',
};
export const modelName = (id) => `Gemini ${NAMES[id] ?? id}`;

const STOP_REASONS = {
  SAFETY: 'Gemini stopped because of its safety filters.',
  RECITATION: 'Gemini stopped because the text looked like it was copied from a published source.',
  PROHIBITED_CONTENT: 'Gemini refused to transcribe this image.',
  BLOCKLIST: 'Gemini refused to transcribe this image.',
  SPII: 'Gemini stopped because the image seems to contain sensitive personal information.',
  IMAGE_SAFETY: 'Gemini stopped because of its image safety filters.',
};

const MAX_ATTEMPTS = 3;
// Thinking can delay the first chunk, so only give up after a long silence.
const SILENCE_MS = 100_000;
// After a model fails as busy, later requests skip it for a while.
const SKIP_MS = 3 * 60_000;
const skipUntil = new Map();

// The model can't serve this request right now; another model might.
class Unavailable extends Error {}

export async function generate({ model, onWait, onSwitch, ...request }) {
  const spec = GEMINI_MODELS.find((m) => m.id === model) ?? GEMINI_MODELS[0];
  const ready = spec.chain.filter((id) => !(skipUntil.get(id) > Date.now()));
  const order = ready.length ? ready : spec.chain;
  let lastError;
  for (const [i, id] of order.entries()) {
    if (i > 0) onSwitch?.(`${modelName(order[i - 1])} is unavailable, trying ${modelName(id)}`);
    try {
      const result = await generateWith(id, request, onWait);
      return { ...result, model: id };
    } catch (err) {
      if (!(err instanceof Unavailable)) throw err;
      skipUntil.set(id, Date.now() + SKIP_MS);
      lastError = err;
    }
  }
  throw new Error(lastError.message);
}

async function generateWith(model, { apiKey, imageB64, system, prompt, signal, onText }, onWait) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [
      {
        role: 'user',
        parts: [
          // High resolution keeps small handwriting legible to the model.
          { inlineData: { mimeType: 'image/jpeg', data: imageB64 }, mediaResolution: { level: 'MEDIA_RESOLUTION_HIGH' } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: { maxOutputTokens: 32768 },
  };

  for (let attempt = 1; ; attempt++) {
    const watchdog = new Watchdog(signal);
    let res;
    try {
      res = await fetch(`${API}/${model}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: watchdog.signal,
      });
      if (res.ok) return await readStream(res, onText, watchdog);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (watchdog.fired) throw new Unavailable(`${modelName(model)} stopped responding.`);
      if (!res) throw new Error("Couldn't reach the Gemini API. Check your connection.", { cause: err });
      // Raised while reading the stream: a stop reason or a mid-stream error.
      throw err;
    } finally {
      watchdog.stop();
    }

    const error = await res.json().catch(() => null);
    // Older models don't know per-image resolution; send the image without it.
    if (res.status === 400 && /media_?resolution/i.test(error?.error?.message ?? '') && body.contents[0].parts[0].mediaResolution) {
      delete body.contents[0].parts[0].mediaResolution;
      continue;
    }
    const message = describeError(res.status, error, model);
    if (!isRetryable(res.status, error)) {
      if (isModelProblem(res.status)) throw new Unavailable(message);
      throw new Error(message);
    }
    // An overloaded model rarely recovers within seconds, so move on sooner.
    if (attempt >= (res.status === 429 ? MAX_ATTEMPTS : 2)) throw new Unavailable(message);
    const wait = retryDelay(res.status, error, attempt);
    onWait?.(Math.ceil(wait / 1000));
    await sleep(wait, signal);
  }
}

async function readStream(res, onText, watchdog) {
  let text = '';
  let finish = null;
  for await (const chunk of sseChunks(res.body)) {
    watchdog.reset();
    if (chunk.error) throw new Unavailable(`Gemini error: ${chunk.error.message}`);
    const blocked = chunk.promptFeedback?.blockReason;
    if (blocked) throw new Error(STOP_REASONS[blocked] ?? `Gemini blocked the request (${blocked}).`);
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.text && !part.thought) {
        text += part.text;
        onText?.(text);
      }
    }
    if (candidate?.finishReason) finish = candidate.finishReason;
  }
  if (finish && STOP_REASONS[finish]) throw new Error(STOP_REASONS[finish]);
  return { text, truncated: finish === 'MAX_TOKENS' };
}

async function* sseChunks(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += value.replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) yield JSON.parse(data);
    }
    if (done) break;
  }
}

// Aborts the request after a long silence, and whenever the caller cancels.
class Watchdog {
  constructor(outer) {
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.fired = false;
    this.outer = outer;
    this.onOuterAbort = () => this.controller.abort(outer.reason);
    outer?.addEventListener('abort', this.onOuterAbort, { once: true });
    this.reset();
  }
  reset() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.fired = true;
      this.controller.abort();
    }, SILENCE_MS);
  }
  stop() {
    clearTimeout(this.timer);
    this.outer?.removeEventListener('abort', this.onOuterAbort);
  }
}

function quotaMessage(error) {
  return error?.error?.message ?? '';
}

function retryInfoSeconds(error) {
  const hint = error?.error?.details?.find((d) => d['@type']?.endsWith('RetryInfo'))?.retryDelay;
  return hint ? parseFloat(hint) : null;
}

// Per-minute rate limits and brief overloads clear up if we wait a little.
function isRetryable(status, error) {
  if (status === 429) {
    if (/limit: 0\b/.test(quotaMessage(error))) return false;
    const seconds = retryInfoSeconds(error);
    return seconds == null || seconds <= 90;
  }
  return status === 500 || status === 503;
}

// Problems that another model might not have: not offered to this key, out of
// quota for the day, or overloaded.
function isModelProblem(status) {
  return status === 404 || status === 429 || status >= 500;
}

function retryDelay(status, error, attempt) {
  if (status === 429) return ((retryInfoSeconds(error) ?? 10 * attempt) + 0.5) * 1000;
  return 3000 * attempt;
}

function describeError(status, error, model) {
  const message = quotaMessage(error);
  const reasons = (error?.error?.details ?? []).map((d) => d.reason).filter(Boolean);
  const name = modelName(model);
  if (reasons.includes('API_KEY_INVALID')) return 'Your Gemini API key was rejected. Check that it was copied correctly.';
  if (status === 429) {
    if (/limit: 0\b/.test(message)) return `${name} needs billing turned on for your key.`;
    return `${name} hit your key's usage limit. Wait a bit, then press Redo.`;
  }
  if (status === 403) return "Your API key can't use the Gemini API. Make sure the key is from Google AI Studio.";
  if (status === 404) return `${name} isn't available for your key.`;
  if (status === 400) return `Gemini rejected the request: ${message || 'bad request'}`;
  if (status >= 500) return `${name} is overloaded right now. Press Redo to try again in a minute.`;
  return message || `Gemini request failed (HTTP ${status}).`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
