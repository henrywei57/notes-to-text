import { toJpegBase64 } from './image.js';

const SDK_URL = 'https://esm.sh/@anthropic-ai/sdk@0.133.0';

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5 (most accurate)', fallbacks: true },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (faster)', fallbacks: true },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 (cheapest)', fallbacks: false },
];

const NO_TEXT = '(no text found)';

const SYSTEM = `You transcribe images of lecture notes (slides, screenshots, whiteboards, and handwritten pages) into clean Markdown.

- Transcribe faithfully. Don't summarize, explain, or add anything, and keep the author's wording and abbreviations.
- Keep the structure: # or ## for titles and section headings, "- " for bullets with two more spaces of indentation per nesting level, "1." for numbered lists, and Markdown tables for tables.
- Write math as LaTeX between $ signs.
- For a diagram or figure, transcribe the labels in it, then add a one-line description in italics, like *[Diagram: ...]*.
- If a word is unreadable, write [illegible] instead of guessing.
- Reply with the transcription only, with no preamble or closing remarks.
- If the image has no text at all, reply with exactly: ${NO_TEXT}`;

let sdkPromise = null;
function loadSdk() {
  sdkPromise ??= import(SDK_URL)
    .then((m) => m.default)
    .catch((err) => {
      sdkPromise = null;
      console.error(err);
      throw new Error("Couldn't load the Claude client. Check your internet connection.");
    });
  return sdkPromise;
}

export async function recognizeClaude(bitmap, { apiKey, model, signal, onText }) {
  const Anthropic = await loadSdk();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const spec = MODELS.find((m) => m.id === model) ?? MODELS[0];

  const params = {
    model: spec.id,
    max_tokens: 16000,
    system: SYSTEM,
    // Transcription doesn't need deep reasoning.
    output_config: { effort: 'low' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: toJpegBase64(bitmap) } },
          { type: 'text', text: 'Transcribe these notes.' },
        ],
      },
    ],
  };
  if (spec.fallbacks) {
    // If a safety check declines the request, the API retries it on a fallback model.
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  let message;
  try {
    const stream = client.beta.messages.stream(params, { signal });
    let shown = '';
    stream.on('streamEvent', (event) => {
      // A fallback model starts the answer over.
      if (event.type === 'content_block_start' && event.content_block.type === 'fallback') shown = '';
    });
    stream.on('text', (delta) => {
      shown += delta;
      onText(shown);
    });
    message = await stream.finalMessage();
  } catch (err) {
    throw new Error(describeError(Anthropic, err), { cause: err });
  }

  if (message.stop_reason === 'refusal') {
    throw new Error('Claude declined to transcribe this image.');
  }
  const lastFallback = message.content.findLastIndex((b) => b.type === 'fallback');
  const text = message.content
    .slice(lastFallback + 1)
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return {
    text: text === NO_TEXT ? '' : text,
    truncated: message.stop_reason === 'max_tokens',
  };
}

function describeError(Anthropic, err) {
  if (err instanceof Anthropic.APIUserAbortError) return 'Cancelled.';
  if (err instanceof Anthropic.AuthenticationError) return 'Your API key was rejected. Check that it was copied correctly.';
  if (err instanceof Anthropic.PermissionDeniedError) return "Your API key doesn't have access to this model.";
  if (err instanceof Anthropic.NotFoundError) return "This model isn't available on your account. Try another one.";
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited. Wait a moment, then press Redo.';
  if (err instanceof Anthropic.BadRequestError) return `The API rejected the request: ${err.error?.error?.message ?? err.message}`;
  if (err instanceof Anthropic.InternalServerError) return 'The Claude API had a problem. Press Redo to try again.';
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Claude API. Check your connection.";
  if (err instanceof Anthropic.APIError) return err.message;
  return err?.message ?? String(err);
}
