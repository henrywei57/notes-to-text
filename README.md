# Notes to Text

Turn photos and screenshots of lecture notes into clean, editable text. Bullet points, sub-bullets, numbered lists, headings, and math come back as Markdown you can paste into Notion, Google Docs, Obsidian, or anywhere else.

**Live site:** https://henrywei57.github.io/notes-to-text/

## Features

- Drag and drop, browse, or paste (Ctrl/⌘+V) any number of images at once
- Reads handwriting, whiteboards, slides, and screenshots
- **Double-check mode:** after the first read, the model compares its transcript against the image line by line and fixes misread words, missing lines, and wrong nesting
- Edit the result in place, then copy or download it as Markdown or plain text

## Engines

| | Gemini (default) | Claude | Quick scan |
|---|---|---|---|
| Accuracy | High, including handwriting | High, including handwriting | Only clean, typed slides |
| Key | Free key from [Google AI Studio](https://aistudio.google.com/apikey) | [Anthropic API key](https://console.anthropic.com/settings/keys) | None |
| Privacy | Images go to Google's API | Images go to Anthropic's API | Images never leave your browser |

The Gemini and Claude engines call their APIs straight from your browser. Your key is only saved if you tick "Remember key on this device", and then only in this browser's local storage. Quick scan uses [Tesseract.js](https://github.com/naptha/tesseract.js).

## Running locally

It's a static site with no build step:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.
