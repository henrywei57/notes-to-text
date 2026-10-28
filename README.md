# Notes to Text

Turn photos and screenshots of lecture notes into clean, editable text. Bullet points, sub-bullets, numbered lists, and slide titles come back as Markdown you can paste into Notion, Google Docs, Obsidian, or anywhere else.

**Live site:** https://henrywei57.github.io/notes-to-text/

## Features

- Drag and drop, browse, or paste (Ctrl/⌘+V) any number of images at once
- Rebuilds bullet structure: nesting depth, numbered lists, headings, and lines the slide wrapped
- Handles dark slides and has a photo clean-up mode for shadows and uneven lighting
- Edit the result in place, then copy or download it as Markdown or plain text

## Two engines

| | On-device | Claude |
|---|---|---|
| Cost | Free | Uses your Anthropic API key |
| Privacy | Images never leave your browser | Images are sent to the Anthropic API |
| Best for | Slides, screenshots, typed notes | Handwriting, whiteboards, math, diagrams |

On-device mode uses [Tesseract.js](https://github.com/naptha/tesseract.js). Claude mode sends each image straight from your browser to `api.anthropic.com`. Your key is only saved if you tick "Remember key on this device", and then only in this browser's local storage.

## Running locally

It's a static site with no build step:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.
