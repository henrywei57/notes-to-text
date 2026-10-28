import { decodeImage } from './image.js';
import { recognizeLocal } from './local-ocr.js';
import { recognizeClaude, MODELS } from './claude-ocr.js';
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
  apiKey: $('#api-key'),
  model: $('#model'),
  rememberKey: $('#remember-key'),
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

for (const m of MODELS) els.model.add(new Option(m.label, m.id));

function radioValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`).value;
}

function setRadio(name, value) {
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

function settings() {
  return {
    engine: radioValue('engine'),
    lang: els.lang.value,
    enhance: els.enhance.checked,
    apiKey: els.apiKey.value.trim(),
    model: els.model.value,
  };
}

function showEngineOptions() {
  const engine = radioValue('engine');
  for (const el of document.querySelectorAll('.opts')) el.hidden = el.dataset.for !== engine;
}

setRadio('engine', store.get('engine', 'local'));
setRadio('format', store.get('format', 'md'));
els.lang.value = store.get('lang', 'eng');
els.enhance.checked = store.get('enhance', false);
els.model.value = store.get('model', MODELS[0].id);
if (!els.model.value) els.model.value = MODELS[0].id;
const savedKey = store.get('apiKey', '');
if (savedKey) {
  els.apiKey.value = savedKey;
  els.rememberKey.checked = true;
}
showEngineOptions();

for (const input of document.querySelectorAll('input[name="engine"]')) {
  input.addEventListener('change', () => {
    store.set('engine', radioValue('engine'));
    showEngineOptions();
    pump();
  });
}
for (const input of document.querySelectorAll('input[name="format"]')) {
  input.addEventListener('change', () => store.set('format', radioValue('format')));
}
els.lang.addEventListener('change', () => store.set('lang', els.lang.value));
els.enhance.addEventListener('change', () => store.set('enhance', els.enhance.checked));
els.model.addEventListener('change', () => store.set('model', els.model.value));

function saveKey() {
  if (els.rememberKey.checked && els.apiKey.value.trim()) store.set('apiKey', els.apiKey.value.trim());
  else store.remove('apiKey');
}
els.rememberKey.addEventListener('change', saveKey);
els.apiKey.addEventListener('input', () => {
  saveKey();
  pump();
});

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

// Queue: the on-device engine works one page at a time; Claude can take a few at once.

function pump() {
  const s = settings();
  const queued = pages.filter((p) => p.status === 'queued');
  if (!queued.length) return;
  if (s.engine === 'claude' && !s.apiKey) {
    for (const p of queued) setStatus(p, 'queued', 'Needs API key');
    return;
  }
  const limit = s.engine === 'claude' ? 3 : 1;
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
    if (s.engine === 'claude') {
      setStatus(page, 'working', 'Sending to Claude');
      setProgress(page, 0.15);
      const result = await recognizeClaude(page.bitmap, {
        apiKey: s.apiKey,
        model: s.model,
        signal: page.controller.signal,
        onText: (partial) => {
          if (page.removed) return;
          page.textarea.value = partial;
          setStatus(page, 'working', 'Transcribing');
          setProgress(page, Math.min(0.95, 0.3 + partial.length / 3000));
        },
      });
      text = result.text;
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
    setStatus(page, 'done', text ? 'Done' : 'No text found');
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
