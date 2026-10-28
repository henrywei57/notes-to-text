import * as gemini from './gemini.js';
import * as claude from './claude.js';
import { toJpegBase64 } from './image.js';
import { TRANSCRIBE, PROOFREAD, proofreadPrompt, cleanTranscript } from './prompts.js';

const ENGINES = {
  // Gemini takes requests up to 20 MB, so it gets a sharper image.
  gemini: { api: gemini, maxLong: 3072, maxChars: 14e6 },
  claude: { api: claude, maxLong: 2400, maxChars: 4.8e6 },
};

// Reads the page, then (in accurate mode) has the model check its own draft
// against the image line by line, which catches most misread words.
export async function recognizeAI(bitmap, { engine, apiKey, model, accurate, signal, onStage, onDraft }) {
  const { api, maxLong, maxChars } = ENGINES[engine];
  const imageB64 = toJpegBase64(bitmap, { maxLong, maxChars });
  const common = {
    apiKey,
    model,
    imageB64,
    signal,
    onWait: (s) => onStage(`Busy, retrying in ${s}s`),
    onSwitch: (message) => onStage(message),
  };

  onStage('Reading the page', 0.1);
  const first = await api.generate({
    ...common,
    system: TRANSCRIBE,
    prompt: 'Transcribe these notes.',
    effort: accurate ? 'medium' : 'low',
    onText: (t) => {
      onDraft(t);
      onStage('Reading the page', Math.min(accurate ? 0.5 : 0.95, 0.15 + t.length / 4000));
    },
  });
  const draft = cleanTranscript(first.text);
  const usedModel = first.model;
  if (!accurate || !draft) return { text: draft, truncated: first.truncated, usedModel };

  onStage('Double-checking against the image', 0.55);
  const second = await api.generate({
    ...common,
    system: PROOFREAD,
    prompt: proofreadPrompt(draft),
    effort: 'medium',
    onText: (t) => onStage('Double-checking against the image', Math.min(0.97, 0.55 + (0.42 * t.length) / draft.length)),
  });
  const checked = cleanTranscript(second.text);
  // A cut-off check would lose the end of the page, so keep the draft instead.
  if (!checked || second.truncated) return { text: draft, truncated: first.truncated, usedModel };
  return { text: checked, truncated: false, usedModel };
}
