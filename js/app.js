import { decodeImage } from './image.js';
import { recognizeLocal } from './local-ocr.js';
import { recognizeAI } from './ai-ocr.js';
import { GEMINI_MODELS, modelName as geminiName } from './gemini.js';
import { CLAUDE_MODELS, modelName as claudeName } from './claude.js';
import { toPlainText } from './layout.js';

const $ = (sel, root = document) => root.querySelector(sel);

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`n2t:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`n2t:${key}`, JSON.stringify(value));
    } catch {}
  },
  remove(key) {
    try {
      localStorage.removeItem(`n2t:${key}`);
    } catch {}
  },
};

const els = {
  lang: $('#lang'),
  enhance: $('#enhance'),
  accurate: $('#accurate'),
  dropzone: $('#dropzone'),
  fileInput: $('#file-input'),
  pages: $('#pages'),
  exportBar: $('#export'),
  viewer: $('#viewer'),
  template: $('#page-tpl'),
};

const pages = [];
let running = 0;
let pastedCount = 0;

// Settings

// Each AI engine has its own key, model, and "remember" box.
const ai = {
  gemini: { models: GEMINI_MODELS, name: geminiName, key: $('#gemini-key'), model: $('#gemini-model'), remember: $('#gemini-remember') },
  claude: { models: CLAUDE_MODELS, name: claudeName, key: $('#claude-key'), model: $('#claude-model'), remember: $('#claude-remember') },
};

for (const [name, cfg] of Object.entries(ai)) {
  for (const m of cfg.models) cfg.model.add(new Option(m.label, m.id));
  cfg.model.value = store.get(`${name}Model`, cfg.models[0].id);
  if (!cfg.model.value) cfg.model.value = cfg.models[0].id;
  const saved = store.get(`${name}Key`, '');
  if (saved) {
    cfg.key.value = saved;
    cfg.remember.checked = true;
  }
  const saveKey = () => {
    if (cfg.remember.checked && cfg.key.value.trim()) store.set(`${name}Key`, cfg.key.value.trim());
    else store.remove(`${name}Key`);
  };
  cfg.remember.addEventListener('change', saveKey);
  cfg.key.addEventListener('input', () => {
    saveKey();
    pump();
  });
  cfg.model.addEventListener('change', () => store.set(`${name}Model`, cfg.model.value));
}

function radioValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`).value;
}

function setRadio(name, value) {
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

function settings() {
  const engine = radioValue('engine');
  return {
    engine,
    lang: els.lang.value,
    enhance: els.enhance.checked,
    accurate: els.accurate.checked,
    apiKey: ai[engine]?.key.value.trim() ?? '',
    model: ai[engine]?.model.value ?? '',
  };
}

function showEngineOptions() {
  const engine = radioValue('engine');
  for (const el of document.querySelectorAll('.opts')) el.hidden = !el.dataset.for.split(' ').includes(engine);
}

// Stored under a new name so returning visitors start on the accurate engine.
setRadio('engine', store.get('engineChoice', 'gemini'));
setRadio('format', store.get('format', 'md'));
els.lang.value = store.get('lang', 'eng');
els.enhance.checked = store.get('enhance', false);
els.accurate.checked = store.get('accurate', true);
showEngineOptions();

for (const input of document.querySelectorAll('input[name="engine"]')) {
  input.addEventListener('change', () => {
    store.set('engineChoice', radioValue('engine'));
    showEngineOptions();
    pump();
  });
}
for (const input of document.querySelectorAll('input[name="format"]')) {
  input.addEventListener('change', () => store.set('format', radioValue('format')));
}
els.lang.addEventListener('change', () => store.set('lang', els.lang.value));
els.enhance.addEventListener('change', () => store.set('enhance', els.enhance.checked));
els.accurate.addEventListener('change', () => store.set('accurate', els.accurate.checked));

if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
  $('.paste-key').textContent = '⌘';
}

// Adding images

function isImage(file) {
  return file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name);
}

function addFiles(fileList) {
  const files = [...fileList].filter(isImage);
  if (!files.length) {
    toast('Those files aren’t images');
    return;
  }
  // Phone photos are named in shooting order, so sorting keeps pages in sequence.
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const file of files) createPage(file);
  updateExportBar();
  pump();
}

els.fileInput.addEventListener('change', () => {
  addFiles(els.fileInput.files);
  els.fileInput.value = '';
});

let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  els.dropzone.classList.add('over');
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.dropzone.classList.remove('over');
});
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  dragDepth = 0;
  els.dropzone.classList.remove('over');
  addFiles(e.dataTransfer.files);
});

document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])].filter(isImage);
  if (!files.length) return;
  e.preventDefault();
  const named = files.map((f) => new File([f], `Pasted image ${++pastedCount}.${f.type.split('/')[1] || 'png'}`, { type: f.type }));
  addFiles(named);
});

// Pages

function createPage(file) {
  const el = els.template.content.firstElementChild.cloneNode(true);
  const page = {
    file,
    el,
    url: URL.createObjectURL(file),
    bitmap: null,
    status: 'queued',
    controller: null,
    removed: false,
    textarea: $('textarea', el),
  };
  $('.thumb img', el).src = page.url;
  $('.thumb img', el).alt = file.name;
  $('.page-name', el).textContent = file.name;
  $('.thumb', el).addEventListener('click', () => {
    $('img', els.viewer).src = page.url;
    els.viewer.showModal();
  });
  $('[data-act="copy"]', el).addEventListener('click', () => copy(formatted(page.textarea.value)));
  $('[data-act="redo"]', el).addEventListener('click', () => {
    if (page.status === 'working') return;
    page.status = 'queued';
    setStatus(page, 'queued', 'Queued');
    pump();
  });
  $('[data-act="remove"]', el).addEventListener('click', () => removePage(page));
  pages.push(page);
  els.pages.append(el);
  return page;
}

function removePage(page) {
  page.removed = true;
  page.controller?.abort();
  URL.revokeObjectURL(page.url);
  page.bitmap?.close();
  page.el.remove();
  pages.splice(pages.indexOf(page), 1);
  updateExportBar();
}

function setStatus(page, state, label) {
  const badge = $('.status', page.el);
  badge.dataset.state = state;
  badge.textContent = label;
}

function setProgress(page, fraction) {
  const bar = $('.progress', page.el);
  bar.hidden = fraction == null;
  if (fraction != null) bar.firstElementChild.style.width = `${Math.round(fraction * 100)}%`;
}

function setError(page, message) {
  const box = $('.error', page.el);
  box.hidden = !message;
  box.textContent = message ?? '';
}

// Queue: the on-device engine works one page at a time. The AI engines take a
// couple at once, kept low so free-tier Gemini keys stay under their rate limit.

const CONCURRENCY = { local: 1, gemini: 2, claude: 3 };

function pump() {
  const s = settings();
  const queued = pages.filter((p) => p.status === 'queued');
  if (!queued.length) return;
  if (ai[s.engine] && !s.apiKey) {
    for (const p of queued) setStatus(p, 'queued', 'Needs API key');
    ai[s.engine].key.focus();
    return;
  }
  const limit = CONCURRENCY[s.engine];
  for (const page of queued) {
    if (running >= limit) break;
    run(page, s);
  }
}

async function run(page, s) {
  running++;
  page.status = 'working';
  page.controller = new AbortController();
  page.textarea.value = '';
  setError(page, null);
  setStatus(page, 'working', 'Starting');
  setProgress(page, 0.03);
  try {
    page.bitmap ??= await decodeImage(page.file);
    let text;
    let doneLabel = 'Done';
    if (ai[s.engine]) {
      const result = await recognizeAI(page.bitmap, {
        engine: s.engine,
        apiKey: s.apiKey,
        model: s.model,
        accurate: s.accurate,
        signal: page.controller.signal,
        onStage: (label, fraction) => {
          if (page.removed) return;
          setStatus(page, 'working', label);
          if (fraction != null) setProgress(page, fraction);
        },
        onDraft: (partial) => {
          if (!page.removed) page.textarea.value = partial;
        },
      });
      text = result.text;
      // Name the model that did the work, since Gemini may have fallen back to another one.
      doneLabel = `Done · ${ai[s.engine].name(result.usedModel)}`;
      if (result.truncated) setError(page, 'The response hit the length limit, so the end may be missing.');
    } else {
      text = await recognizeLocal(page.bitmap, {
        lang: s.lang,
        enhance: s.enhance,
        onProgress: (fraction, label) => {
          setStatus(page, 'working', label);
          setProgress(page, fraction);
        },
      });
    }
    if (page.removed) return;
    page.textarea.value = text;
    page.status = 'done';
    setStatus(page, 'done', text ? doneLabel : 'No text found');
  } catch (err) {
    if (page.removed) return;
    console.error(err);
    page.status = 'error';
    setStatus(page, 'error', 'Failed');
    setError(page, err.message || String(err));
  } finally {
    running--;
    page.controller = null;
    if (!page.removed) setProgress(page, null);
    pump();
  }
}

// Export

function formatted(md) {
  return radioValue('format') === 'txt' ? toPlainText(md) : md.trim();
}

function combinedText() {
  const parts = pages.map((p) => formatted(p.textarea.value)).filter(Boolean);
  return parts.join(radioValue('format') === 'txt' ? '\n\n\n' : '\n\n---\n\n');
}

function updateExportBar() {
  els.exportBar.hidden = !pages.length;
}

async function copy(text) {
  if (!text) {
    toast('Nothing to copy yet');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Your browser blocked the clipboard');
  }
}

$('#copy-all').addEventListener('click', () => copy(combinedText()));

$('#download-all').addEventListener('click', () => {
  const text = combinedText();
  if (!text) {
    toast('Nothing to download yet');
    return;
  }
  const ext = radioValue('format') === 'txt' ? 'txt' : 'md';
  const date = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' }));
  a.download = `lecture-notes-${date}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#clear-all').addEventListener('click', () => {
  const hasText = pages.some((p) => p.textarea.value.trim());
  if (hasText && !confirm('Remove all pages and their text?')) return;
  for (const page of [...pages]) removePage(page);
});

els.viewer.addEventListener('click', (e) => {
  if (e.target === els.viewer) els.viewer.close();
});

function toast(message) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.append(el);
  el.addEventListener('animationend', () => el.remove());
}
