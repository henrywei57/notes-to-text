const API = 'https://generativelanguage.googleapis.com/v1beta/models';

export const GEMINI_MODELS = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (works on the free tier)' },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon (most accurate, paid plan)' },
];

const STOP_REASONS = {
  SAFETY: 'Gemini stopped because of its safety filters.',
  RECITATION: 'Gemini stopped because the text looked like it was copied from a published source.',
  PROHIBITED_CONTENT: 'Gemini refused to transcribe this image.',
  BLOCKLIST: 'Gemini refused to transcribe this image.',
  SPII: 'Gemini stopped because the image seems to contain sensitive personal information.',
  IMAGE_SAFETY: 'Gemini stopped because of its image safety filters.',
};

const MAX_ATTEMPTS = 4;

export async function generate({ apiKey, model, imageB64, system, prompt, signal, onText, onWait }) {
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
    let res;
    try {
      res = await fetch(`${API}/${model}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error("Couldn't reach the Gemini API. Check your connection.", { cause: err });
    }
    if (res.ok) return readStream(res, onText);

    const error = await res.json().catch(() => null);
    // Older models don't know per-image resolution; send the image without it.
    if (res.status === 400 && /media_?resolution/i.test(error?.error?.message ?? '') && body.contents[0].parts[0].mediaResolution) {
      delete body.contents[0].parts[0].mediaResolution;
      continue;
    }
    const wait = retryDelay(res.status, error, attempt);
    if (wait == null || attempt >= MAX_ATTEMPTS) throw new Error(describeError(res.status, error, model));
    onWait?.(Math.ceil(wait / 1000));
    await sleep(wait, signal);
  }
}

async function readStream(res, onText) {
  let text = '';
  let finish = null;
  for await (const chunk of sseChunks(res.body)) {
    if (chunk.error) throw new Error(`Gemini error: ${chunk.error.message}`);
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
  if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS' && STOP_REASONS[finish]) {
    throw new Error(STOP_REASONS[finish]);
  }
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

// Retry rate limits and server hiccups; everything else is the caller's problem.
function retryDelay(status, error, attempt) {
  if (status === 429) {
    if (isFreeTierBlock(error)) return null;
    const hint = error?.error?.details?.find((d) => d['@type']?.endsWith('RetryInfo'))?.retryDelay;
    const seconds = hint ? parseFloat(hint) : 10 * attempt;
    return seconds <= 90 ? seconds * 1000 + 500 : null;
  }
  if (status === 500 || status === 503) return 2000 * attempt;
  return null;
}

// A quota of zero means the model isn't offered on this key's tier at all, so waiting won't help.
function isFreeTierBlock(error) {
  return /limit: 0\b/.test(error?.error?.message ?? '');
}

function describeError(status, error, model) {
  const message = error?.error?.message ?? '';
  const reasons = (error?.error?.details ?? []).map((d) => d.reason).filter(Boolean);
  if (reasons.includes('API_KEY_INVALID')) return 'Your Gemini API key was rejected. Check that it was copied correctly.';
  if (status === 429) {
    if (isFreeTierBlock(error)) {
      return `${model} isn't available on the free tier. Switch to Gemini 3.8 Flash, or turn on billing for your key.`;
    }
    return 'You hit the Gemini rate limit. Wait a minute, then press Redo.';
  }
  if (status === 403) return "Your API key can't use the Gemini API. Make sure the key is from Google AI Studio.";
  if (status === 404) return `The model ${model} isn't available for your key. Try the other Gemini model.`;
  if (status === 400) return `Gemini rejected the request: ${message || 'bad request'}`;
  if (status >= 500) return 'Gemini is having problems right now. Press Redo to try again.';
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
