const SDK_URL = 'https://esm.sh/@anthropic-ai/sdk@0.133.0';

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5 (most accurate)', fallbacks: true },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (faster)', fallbacks: true },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 (cheapest)', fallbacks: false },
];

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

export async function generate({ apiKey, model, imageB64, system, prompt, effort, signal, onText }) {
  const Anthropic = await loadSdk();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const spec = CLAUDE_MODELS.find((m) => m.id === model) ?? CLAUDE_MODELS[0];

  const params = {
    model: spec.id,
    max_tokens: 16000,
    system,
    output_config: { effort },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } },
          { type: 'text', text: prompt },
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
      onText?.(shown);
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
    .join('');
  return { text, truncated: message.stop_reason === 'max_tokens' };
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
