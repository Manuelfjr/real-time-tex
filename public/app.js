import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/pdf.min.mjs';
import * as Y from 'https://esm.sh/yjs@13.6.32';
import { CodemirrorBinding } from 'https://esm.sh/y-codemirror@3?deps=yjs@13.6.32';
import { HocuspocusProvider } from 'https://esm.sh/@hocuspocus/provider@4?deps=yjs@13.6.32';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/pdf.worker.min.mjs';

const PROJECT_ID = new URLSearchParams(location.search).get('id');
if (!PROJECT_ID) {
  location.href = 'index.html';
  throw new Error('Nenhum projeto selecionado.');
}
// Caminhos relativos: o app funciona na raiz ou sob um subcaminho (ex.: /latex/).
const api = (p) => `api/projects/${encodeURIComponent(PROJECT_ID)}${p}`;

const DEBOUNCE_MS = 700;

const statusEl = document.getElementById('status');
const compileBtn = document.getElementById('compile-btn');
const pdfViewerEl = document.getElementById('pdf-viewer');
const pdfPlaceholder = document.getElementById('pdf-placeholder');
const pageIndicator = document.getElementById('page-indicator');
const logPanel = document.getElementById('log-panel');
const logHeader = document.getElementById('log-header');
const logContent = document.getElementById('log-content');
const zoomInBtn = document.getElementById('zoom-in');
const zoomOutBtn = document.getElementById('zoom-out');
const zoomFitBtn = document.getElementById('zoom-fit');
const fileListEl = document.getElementById('file-list');
const fileInput = document.getElementById('file-input');
const fileSidebar = document.getElementById('file-sidebar');
const autocompileCheckbox = document.getElementById('autocompile-checkbox');
const downloadLink = document.getElementById('download-link');
const presenceRow = document.getElementById('presence-row');
const mainFileRow = document.getElementById('main-file-row');
const mainFileNameEl = document.getElementById('main-file-name');

let pdfLoaded = false;
let debounceTimer = null;
let dirty = false;

const cm = CodeMirror.fromTextArea(document.getElementById('editor'), {
  mode: 'stex',
  theme: 'material-darker',
  lineNumbers: true,
  lineWrapping: true,
  tabSize: 2,
  indentUnit: 2,
  autofocus: true,
});

// ------------------------------------------------------------------
// Autocompile toggle: when off, edits only mark the doc as dirty and
// compilation happens solely via the "Compilar agora" button.
// ------------------------------------------------------------------

const AUTOCOMPILE_STORAGE_KEY = 'latex-live:autocompile';
let autoCompile = true;
try {
  const saved = localStorage.getItem(AUTOCOMPILE_STORAGE_KEY);
  if (saved !== null) autoCompile = saved === 'true';
} catch (err) {
  // localStorage unavailable (private mode, etc.) — keep default
}
autocompileCheckbox.checked = autoCompile;

autocompileCheckbox.addEventListener('change', () => {
  autoCompile = autocompileCheckbox.checked;
  try {
    localStorage.setItem(AUTOCOMPILE_STORAGE_KEY, String(autoCompile));
  } catch (err) {
    // ignore
  }
  if (autoCompile && dirty) {
    clearTimeout(debounceTimer);
    compile();
  }
});

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

// ------------------------------------------------------------------
// Live collaboration: the CodeMirror buffer is bound to a shared Yjs
// document synced through our own server (Hocuspocus), so every open tab
// for this project — yours or a collaborator's — edits the same text in
// real time. The server persists it to the project's file on disk (see
// server.js's onStoreDocument), so the content is still there the next
// time anyone opens it, whether or not someone else is online then.
// ------------------------------------------------------------------

const USERNAME_STORAGE_KEY = 'latex-live:username';
const PRESENCE_COLORS = ['#F04E44', '#246A3C', '#3A2FDF', '#D73E5F', '#9355A0', '#7D470A'];

function getOrPromptUsername() {
  let name = '';
  try {
    name = localStorage.getItem(USERNAME_STORAGE_KEY) || '';
  } catch (err) {
    // ignore
  }
  if (!name) {
    name = (prompt('Seu nome (aparece para os outros editores):', '') || '').trim() || 'Convidado';
    try {
      localStorage.setItem(USERNAME_STORAGE_KEY, name);
    } catch (err) {
      // ignore
    }
  }
  return name;
}

function colorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length];
}

function renderPresence(awareness) {
  const states = Array.from(awareness.getStates().values())
    .map((s) => s.user)
    .filter(Boolean);
  presenceRow.innerHTML = '';
  for (const user of states) {
    const dot = document.createElement('span');
    dot.className = 'presence-dot';
    dot.style.background = user.color;
    dot.title = user.name;
    dot.textContent = user.name.slice(0, 1).toUpperCase();
    presenceRow.appendChild(dot);
  }
}

let mainFileRel = null; // set once from the project's metadata, at startup
let currentFile = null; // relative path of whatever connectToFile last opened
let currentProvider = null;
let currentBinding = null;
let firstSyncHandled = false;

// Switches the editor to a given file in the project (defaults to the main
// file). Each file is its own Yjs document ("<projectId>:<relPath>"),
// bridged to that exact file on disk server-side, so any of them — not just
// the main file — can be opened, edited live with collaborators, and stays
// saved whether or not anyone's connected.
function connectToFile(relPath, onReady) {
  if (relPath === currentFile) {
    if (onReady) onReady();
    return;
  }
  if (currentBinding) currentBinding.destroy();
  if (currentProvider) currentProvider.destroy();

  currentFile = relPath;
  updateActiveFileUI();

  const ydoc = new Y.Doc();
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const isMain = relPath === mainFileRel;

  const provider = new HocuspocusProvider({
    url: `${wsProtocol}//${location.host}${location.pathname.replace(/[^/]*$/, '')}collab`,
    name: `${PROJECT_ID}:${relPath}`,
    document: ydoc,
    onSynced: async () => {
      if (isMain && !firstSyncHandled) {
        firstSyncHandled = true;
        // Show whatever was last compiled immediately instead of always
        // forcing a fresh compile on join — for a big document that can
        // take a while, and nothing changed since the last compile most of
        // the time anyway. Edits still trigger a real recompile as normal;
        // this only skips the redundant one when there's nothing new to
        // show for it yet.
        const cached = await tryLoadCachedPdf();
        if (!cached) compile();
      }
      if (onReady) onReady();
    },
  });
  currentProvider = provider;

  const username = getOrPromptUsername();
  provider.awareness.setLocalStateField('user', { name: username, color: colorForName(username) });
  renderPresence(provider.awareness);
  provider.awareness.on('change', () => renderPresence(provider.awareness));

  const yText = ydoc.getText('content');
  const yUndoManager = new Y.UndoManager(yText);
  currentBinding = new CodemirrorBinding(yText, cm, provider.awareness, { yUndoManager });

  cm.setOption('readOnly', false);
  setStatus(isMain ? 'Carregando…' : `Editando ${relPath}`, isMain ? undefined : 'pending');
  updateActiveFileUI();
}

function updateActiveFileUI() {
  if (mainFileNameEl) mainFileNameEl.textContent = mainFileRel || 'main.tex';
  if (mainFileRow) mainFileRow.classList.toggle('active', currentFile === mainFileRel);
  fileListEl.querySelectorAll('.tree-row[data-path]').forEach((row) => {
    row.classList.toggle('active', row.dataset.path === currentFile);
  });
}

mainFileRow.addEventListener('click', () => connectToFile(mainFileRel));

// Loads whatever PDF is already sitting on disk (from an earlier compile —
// by this session or anyone else's), if any. Used on first connect so
// joining a project with a big, slow-to-compile document shows something
// immediately instead of forcing everyone through a fresh compile every
// time someone opens it.
async function tryLoadCachedPdf() {
  try {
    const head = await fetch(api('/output.pdf'), { method: 'HEAD' });
    if (head.status !== 200) return false; // 204 = ainda não há PDF
    await renderPdf(api('/output.pdf') + '?t=' + Date.now());
    pdfLoaded = true;
    pdfPlaceholder.classList.add('hidden');
    pageIndicator.classList.remove('hidden');
    setStatus('Compilado ✓', 'ok');
    return true;
  } catch {
    return false;
  }
}

// Every compile result carries a per-project sequence number (`seq`) from
// the server, so whichever of the two paths below applies it first wins and
// the other becomes a no-op instead of a redundant re-render.
let lastAppliedCompileSeq = -1;

async function compile() {
  dirty = false;
  setStatus('Compilando…');
  compileBtn.disabled = true;
  try {
    // Yjs already keeps the main file on disk in sync (onStoreDocument), so
    // compiling never needs the editor's current buffer — good, because
    // that buffer might currently be showing a different file (e.g. a
    // chapter opened from the sidebar), and sending it here would
    // overwrite main.tex with the wrong content.
    const res = await fetch(api('/compile'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const result = await res.json();
    // Applied directly here rather than waiting on the /compile-events
    // broadcast (see subscribeToCompileEvents) — this is the one client
    // that already knows for certain the compile finished, so it shouldn't
    // depend on a second, separate connection to find out. Other viewers,
    // who don't have a request of their own in flight, still get the
    // update via that broadcast.
    await handleCompileResult(result);
  } catch (err) {
    setStatus('Erro ao conectar com o servidor.', 'error');
    logPanel.classList.add('has-error');
    logPanel.classList.remove('collapsed');
    logContent.textContent = String(err);
  } finally {
    compileBtn.disabled = false;
  }
}

// Stays open for the life of the tab (the browser's EventSource
// auto-reconnects on drops), pushing every compile result — whoever
// triggered it — to this viewer's preview pane. Covers edits made by other
// collaborators, which this tab has no request of its own to learn from.
function subscribeToCompileEvents() {
  const source = new EventSource(api('/compile-events'));
  let connectedBefore = false;
  source.addEventListener('open', () => {
    // A reconnect (not the first connection) means we may have missed a
    // broadcast while offline — catch up on whatever's current now.
    if (connectedBefore) tryLoadCachedPdf();
    connectedBefore = true;
  });
  source.onmessage = (evt) => {
    try {
      handleCompileResult(JSON.parse(evt.data));
    } catch {
      // ignore malformed data
    }
  };
}

async function handleCompileResult(result) {
  // `seq` is absent on the cached-PDF-on-join path (tryLoadCachedPdf), which
  // doesn't come from the compile queue and has nothing to deduplicate
  // against, so it's only checked when present.
  if (typeof result.seq === 'number') {
    if (result.seq <= lastAppliedCompileSeq) return;
    lastAppliedCompileSeq = result.seq;
  }
  logContent.textContent = result.log || '';

  if (result.success) {
    try {
      await renderPdf(api('/output.pdf') + '?t=' + Date.now());
      pdfLoaded = true;
      pdfPlaceholder.classList.add('hidden');
      pageIndicator.classList.remove('hidden');
      setStatus('Compilado ✓', 'ok');
      logPanel.classList.remove('has-error');
      logPanel.classList.add('collapsed');
    } catch (err) {
      setStatus('PDF gerado, mas falhou ao exibir ✗', 'error');
      logPanel.classList.add('has-error');
      logPanel.classList.remove('collapsed');
      logContent.textContent = (result.log || '') + '\n\n[Erro ao renderizar o PDF no navegador]\n' + err;
    }
  } else {
    setStatus('Erro de compilação ✗', 'error');
    logPanel.classList.add('has-error');
    logPanel.classList.remove('collapsed');
    if (!pdfLoaded) {
      pdfPlaceholder.textContent = 'Erro na primeira compilação — veja o log abaixo.';
    }
  }
}

function scheduleCompile() {
  dirty = true;
  if (!autoCompile) {
    setStatus('Alterações pendentes — clique em "Compilar agora"', 'pending');
    return;
  }
  setStatus('Editando…');
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(compile, DEBOUNCE_MS);
}

cm.on('change', scheduleCompile);
compileBtn.addEventListener('click', () => {
  clearTimeout(debounceTimer);
  compile();
});

logHeader.addEventListener('click', () => {
  logPanel.classList.toggle('collapsed');
});

// ------------------------------------------------------------------
// PDF rendering (PDF.js onto <canvas>, continuous scroll, no native
// browser PDF chrome — mirrors Overleaf's preview instead of an iframe).
//
// Virtualized like PDF.js's own viewer: only pages within RENDER_MARGIN_PX
// of the visible area get an actual <canvas>; pages that scroll further
// away are evicted back to an empty (but correctly-sized, so scrolling
// never jumps) placeholder. A heavy thesis with hundreds of image-filled
// pages would otherwise hold every page's full-resolution canvas in memory
// at once, which is enough to stall or crash the tab.
// ------------------------------------------------------------------

const RENDER_MARGIN_PX = 1500;

let currentPdfDoc = null;
let zoomMode = 'fit'; // 'fit' | 'manual'
let manualScale = 1.2;
let lastScale = 1;
let renderToken = 0;
let pageEntries = []; // { pageNum, page, viewport, wrapper, canvas, rendering }
let renderObserver = null;
let visibleObserver = null;

async function renderPdf(url) {
  const token = ++renderToken;
  // Pass the URL straight through so PDF.js streams it (HTTP range
  // requests, which Express's static/sendFile already support) instead of
  // buffering the whole file in memory before it can show a single page.
  const pdf = await pdfjsLib.getDocument({ url }).promise;
  if (token !== renderToken) return;
  currentPdfDoc = pdf;
  await rebuildVirtualPages(token);
}

async function rebuildVirtualPages(token) {
  if (!currentPdfDoc) return;
  if (token === undefined) token = ++renderToken;

  // Onde a leitura estava (página no topo da área visível e o quanto dela já
  // passou): recriar as páginas zera a rolagem, e sem isso cada compilação
  // (ou zoom) voltava ao início do PDF.
  const anchor = readingAnchor();

  if (renderObserver) renderObserver.disconnect();
  if (visibleObserver) visibleObserver.disconnect();
  pageEntries = [];
  pdfViewerEl.innerHTML = '';

  const containerWidth = pdfViewerEl.clientWidth - 32;
  const fragment = document.createDocumentFragment();

  for (let pageNum = 1; pageNum <= currentPdfDoc.numPages; pageNum++) {
    // getPage()/getViewport() only read page metadata — cheap, no pixels
    // are rendered here, so this loop stays fast even for huge documents.
    const page = await currentPdfDoc.getPage(pageNum);
    if (token !== renderToken) return;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = zoomMode === 'fit' ? containerWidth / baseViewport.width : manualScale;
    if (pageNum === 1) lastScale = scale;
    const viewport = page.getViewport({ scale });

    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page';
    wrapper.dataset.pageNumber = String(pageNum);
    wrapper.style.width = Math.floor(viewport.width) + 'px';
    wrapper.style.height = Math.floor(viewport.height) + 'px';

    fragment.appendChild(wrapper);
    pageEntries.push({ pageNum, page, viewport, wrapper, canvas: null, rendering: false });
  }

  if (token !== renderToken) return;
  pdfViewerEl.appendChild(fragment);
  restoreReadingAnchor(anchor);
  setupPageObservers(token);
}

// Topo de uma página em coordenadas de rolagem do visualizador.
function pageTop(el) {
  return el.getBoundingClientRect().top - pdfViewerEl.getBoundingClientRect().top + pdfViewerEl.scrollTop;
}

function readingAnchor() {
  const top = pdfViewerEl.scrollTop;
  if (!top) return null;
  const pages = pdfViewerEl.querySelectorAll('.pdf-page');
  for (let i = 0; i < pages.length; i++) {
    const t = pageTop(pages[i]), h = pages[i].offsetHeight;
    if (t + h > top) return { index: i, fraction: Math.max(0, (top - t) / h), left: pdfViewerEl.scrollLeft };
  }
  return pages.length ? { index: pages.length - 1, fraction: 1, left: pdfViewerEl.scrollLeft } : null;
}

// Volta à mesma página e ao mesmo ponto dela; se o documento encolheu, fica
// na última página que ainda existe.
function restoreReadingAnchor(anchor) {
  if (!anchor) return;
  const pages = pdfViewerEl.querySelectorAll('.pdf-page');
  if (!pages.length) return;
  const el = pages[Math.min(anchor.index, pages.length - 1)];
  pdfViewerEl.scrollTop = pageTop(el) + anchor.fraction * el.offsetHeight;
  pdfViewerEl.scrollLeft = anchor.left;
}

function setupPageObservers(token) {
  const total = currentPdfDoc.numPages;
  pageIndicator.textContent = `1 / ${total}`;

  // Renders pages as they approach the viewport and evicts their canvas
  // (freeing its pixel memory) once they scroll well past it.
  renderObserver = new IntersectionObserver(
    (entries) => {
      if (token !== renderToken) return;
      for (const entry of entries) {
        const info = pageEntries[Number(entry.target.dataset.pageNumber) - 1];
        if (!info) continue;
        if (entry.isIntersecting) {
          renderPageIfNeeded(info, token);
        } else {
          evictPage(info);
        }
      }
    },
    { root: pdfViewerEl, rootMargin: `${RENDER_MARGIN_PX}px 0px` }
  );

  // Tracks which page is actually on screen for the page-indicator badge,
  // independent of the expanded render margin above.
  visibleObserver = new IntersectionObserver(
    (entries) => {
      let best = null;
      for (const entry of entries) {
        if (entry.isIntersecting && (!best || entry.intersectionRatio > best.intersectionRatio)) {
          best = entry;
        }
      }
      if (best) {
        pageIndicator.textContent = `${best.target.dataset.pageNumber} / ${total}`;
      }
    },
    { root: pdfViewerEl, threshold: [0.1, 0.25, 0.5, 0.75, 1] }
  );

  for (const info of pageEntries) {
    renderObserver.observe(info.wrapper);
    visibleObserver.observe(info.wrapper);
  }
}

async function renderPageIfNeeded(info, token) {
  if (info.canvas || info.rendering) return;
  info.rendering = true;
  try {
    // Cap the resolution multiplier: on a 3x-DPI display a naive canvas
    // would be 9x the pixel count of a 1x canvas for no visible benefit.
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(info.viewport.width * outputScale);
    canvas.height = Math.floor(info.viewport.height * outputScale);
    const ctx = canvas.getContext('2d');
    const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
    await info.page.render({ canvasContext: ctx, viewport: info.viewport, transform }).promise;
    if (token !== renderToken) return;
    canvas.addEventListener('dblclick', (e) => {
      jumpToSource(info.pageNum, e.offsetX / info.viewport.scale, e.offsetY / info.viewport.scale);
    });
    info.wrapper.innerHTML = '';
    info.wrapper.appendChild(canvas);
    info.canvas = canvas;
  } catch (err) {
    console.error(`Falha ao renderizar a página ${info.pageNum}`, err);
  } finally {
    info.rendering = false;
  }
}

function evictPage(info) {
  if (!info.canvas) return;
  info.wrapper.innerHTML = '';
  info.canvas = null;
}

// ------------------------------------------------------------------
// PDF -> source sync (SyncTeX): double-click a spot in the preview to jump
// the editor to that exact line, the same way Overleaf's preview does.
// ------------------------------------------------------------------

function flashLine(line) {
  cm.addLineClass(line, 'background', 'sync-flash');
  setTimeout(() => cm.removeLineClass(line, 'background', 'sync-flash'), 1200);
}

async function jumpToSource(page, x, y) {
  try {
    const res = await fetch(api('/sync'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page, x, y }),
    });
    const data = await res.json();
    if (!data.success) return;
    const targetFile = data.isMainFile ? mainFileRel : data.file;
    if (!targetFile) return;
    const line = Math.max(0, data.line - 1);
    connectToFile(targetFile, () => {
      cm.setCursor({ line, ch: 0 });
      cm.scrollIntoView({ line, ch: 0 }, 100);
      cm.focus();
      flashLine(line);
    });
  } catch (err) {
    console.error('Falha ao sincronizar PDF -> código', err);
  }
}

zoomInBtn.addEventListener('click', () => {
  zoomMode = 'manual';
  manualScale = Math.min(4, lastScale * 1.15);
  rebuildVirtualPages().catch((err) => console.error('Falha ao aplicar zoom', err));
});

zoomOutBtn.addEventListener('click', () => {
  zoomMode = 'manual';
  manualScale = Math.max(0.3, lastScale / 1.15);
  rebuildVirtualPages().catch((err) => console.error('Falha ao aplicar zoom', err));
});

zoomFitBtn.addEventListener('click', () => {
  zoomMode = 'fit';
  rebuildVirtualPages().catch((err) => console.error('Falha ao ajustar zoom', err));
});

let resizeTimer = null;
new ResizeObserver(() => {
  if (zoomMode !== 'fit' || !currentPdfDoc) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    rebuildVirtualPages().catch((err) => console.error('Falha ao redimensionar preview', err));
  }, 120);
}).observe(document.querySelector('.preview-container'));

// ------------------------------------------------------------------
// Resizable split between editor and preview
// ------------------------------------------------------------------

const divider = document.getElementById('divider');
const editorPane = document.querySelector('.editor-pane');
const previewPane = document.querySelector('.preview-pane');
const splitArea = document.getElementById('split-area');

let dragging = false;
divider.addEventListener('mousedown', () => {
  dragging = true;
  document.body.style.cursor = 'col-resize';
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const rect = splitArea.getBoundingClientRect();
  const pct = Math.min(80, Math.max(20, ((e.clientX - rect.left) / rect.width) * 100));
  editorPane.style.flex = `0 0 ${pct}%`;
  previewPane.style.flex = `0 0 ${100 - pct}%`;
});
window.addEventListener('mouseup', () => {
  if (dragging) {
    dragging = false;
    document.body.style.cursor = '';
    cm.refresh();
  }
});

// ------------------------------------------------------------------
// Project name: shown in the topbar, persisted server-side, and used
// as the downloaded PDF's filename.
// ------------------------------------------------------------------

const projectNameInput = document.getElementById('project-name');

function slugifyForFilename(name) {
  return (
    (name || 'documento')
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .slice(0, 80) || 'documento'
  );
}

function applyProjectName(name) {
  projectNameInput.value = name;
  document.title = name ? `${name} — LaTeX Live` : 'LaTeX Live';
  downloadLink.href = api('/output.pdf');
  downloadLink.download = slugifyForFilename(name) + '.pdf';
}

async function loadProjectName() {
  try {
    const res = await fetch(api(''));
    const data = await res.json();
    applyProjectName(data.name || '');
    mainFileRel = data.mainFile || 'main.tex';
  } catch (err) {
    // keep the placeholder if this fails — non-critical
    mainFileRel = mainFileRel || 'main.tex';
  }
  connectToFile(mainFileRel);
}

async function saveProjectName() {
  const name = projectNameInput.value.trim() || 'Documento sem título';
  applyProjectName(name);
  try {
    await fetch(api(''), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  } catch (err) {
    console.error('Falha ao salvar nome do projeto', err);
  }
}

projectNameInput.addEventListener('blur', saveProjectName);
projectNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    projectNameInput.blur();
  }
});

// ------------------------------------------------------------------
// Project files sidebar: a folder tree for images, .bib, chapter .tex
// files and the like. Clicking a file inserts the matching LaTeX
// snippet at the cursor; folders can be created, and both files and
// folders can be renamed or deleted.
// ------------------------------------------------------------------

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];
const EDITABLE_EXT = ['tex', 'bib', 'sty', 'cls'];
let pendingUploadFolder = '';

function extOf(name) {
  const parts = name.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function iconFor(name) {
  const ext = extOf(name);
  if (IMAGE_EXT.includes(ext)) return '🖼️';
  if (ext === 'pdf') return '📄';
  if (ext === 'bib') return '📚';
  if (ext === 'tex') return '📝';
  if (ext === 'cls' || ext === 'sty') return '🧩';
  return '📎';
}

// Sidebar paths are relative to the project root, but LaTeX resolves
// \input/\includegraphics against the main file's own folder (the compile
// runs there) — which differs whenever the main file sits in a subfolder, as
// in most imported projects. Rewrites a root-relative path to that base.
function pathFromMainFile(relPath) {
  const base = (mainFileRel || '').split('/').slice(0, -1);
  const target = relPath.split('/');
  let shared = 0;
  while (shared < base.length && shared < target.length - 1 && base[shared] === target[shared]) shared++;
  return [...Array(base.length - shared).fill('..'), ...target.slice(shared)].join('/');
}

function snippetFor(rootRelPath) {
  const relPath = pathFromMainFile(rootRelPath);
  const ext = extOf(relPath);
  if (IMAGE_EXT.includes(ext) || ext === 'pdf' || ext === 'eps') {
    return `\\includegraphics[width=0.8\\linewidth]{${relPath}}`;
  }
  if (ext === 'bib') {
    return `\\bibliography{${relPath.replace(/\.bib$/i, '')}}`;
  }
  if (ext === 'cls' || ext === 'sty') {
    return `% ${relPath} disponível no projeto`;
  }
  return `\\input{${relPath}}`;
}

// Inserting at "the cursor" is only safe when the user actually just placed
// it there by clicking into the editor. Clicking a sidebar file without
// having focused the editor first left the cursor wherever it happened to
// be (often line 0, i.e. before \documentclass) — insert at a safe spot
// instead: just before \end{document}, or at the very end if there isn't
// one yet.
function insertSnippetSafely(snippet) {
  if (cm.hasFocus()) {
    cm.replaceSelection(snippet);
    cm.focus();
    return;
  }
  const lastLine = cm.lastLine();
  let target = lastLine + 1;
  for (let line = lastLine; line >= 0; line--) {
    if (/\\end\{document\}/.test(cm.getLine(line))) {
      target = line;
      break;
    }
  }
  cm.replaceRange(snippet + '\n', { line: target, ch: 0 });
  cm.focus();
}

async function fetchFiles() {
  try {
    const res = await fetch(api('/files'));
    const data = await res.json();
    renderFileTree(data.tree || []);
  } catch (err) {
    fileListEl.innerHTML = '<li class="file-empty">Erro ao listar arquivos</li>';
  }
}

function renderFileTree(tree) {
  fileListEl.innerHTML = '';
  if (tree.length === 0) {
    fileListEl.innerHTML = '<li class="file-empty">Nenhum arquivo ainda</li>';
  } else {
    for (const node of tree) {
      fileListEl.appendChild(buildTreeNode(node));
    }
  }
  updateActiveFileUI();
}

function buildTreeNode(node) {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'tree-row';

  const del = document.createElement('span');
  del.className = 'tree-action';
  del.textContent = '✕';
  del.title = node.type === 'folder' ? 'Excluir pasta' : 'Excluir arquivo';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteItem(node);
  });

  const rename = document.createElement('span');
  rename.className = 'tree-action';
  rename.textContent = '✎';
  rename.title = 'Renomear';
  rename.addEventListener('click', (e) => {
    e.stopPropagation();
    renameItem(node);
  });

  const actions = document.createElement('span');
  actions.className = 'tree-actions';

  if (node.type === 'folder') {
    li.className = 'tree-folder';

    const caret = document.createElement('span');
    caret.className = 'folder-caret';
    caret.textContent = '▾';

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = '📁';

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = node.name;

    const addBtn = document.createElement('span');
    addBtn.className = 'tree-action';
    addBtn.textContent = '+';
    addBtn.title = 'Adicionar arquivo nesta pasta';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pendingUploadFolder = node.path;
      fileInput.click();
    });

    actions.appendChild(addBtn);
    actions.appendChild(rename);
    actions.appendChild(del);

    row.appendChild(caret);
    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(actions);
    row.title = node.name;

    row.addEventListener('click', () => li.classList.toggle('collapsed'));
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('drag-over');
      uploadFiles(e.dataTransfer.files, node.path);
    });

    li.appendChild(row);

    const children = document.createElement('ul');
    children.className = 'tree-children';
    for (const child of node.children) {
      children.appendChild(buildTreeNode(child));
    }
    li.appendChild(children);
  } else {
    li.className = 'tree-file';
    row.dataset.path = node.path;

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = iconFor(node.name);

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = node.name;

    const editable = EDITABLE_EXT.includes(extOf(node.name));

    if (editable) {
      const insertRef = document.createElement('span');
      insertRef.className = 'tree-action';
      insertRef.textContent = '⇥';
      insertRef.title = 'Inserir referência no arquivo aberto';
      insertRef.addEventListener('click', (e) => {
        e.stopPropagation();
        insertSnippetSafely(snippetFor(node.path));
      });
      actions.appendChild(insertRef);
    }
    actions.appendChild(rename);
    actions.appendChild(del);

    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(actions);

    if (editable) {
      row.title = 'Clique para abrir e editar este arquivo';
      row.addEventListener('click', () => connectToFile(node.path));
    } else {
      row.title = 'Clique para inserir no editor';
      row.addEventListener('click', () => {
        insertSnippetSafely(snippetFor(node.path));
      });
    }

    li.appendChild(row);
  }

  return li;
}

async function uploadFiles(fileListLike, folder) {
  const files = Array.from(fileListLike || []);
  if (files.length === 0) return;
  const formData = new FormData();
  // "folder" must be appended before the files: multer/busboy populate
  // req.body as the multipart stream is parsed, in order.
  formData.append('folder', folder || '');
  files.forEach((f) => formData.append('files', f));
  try {
    const res = await fetch(api('/files'), { method: 'POST', body: formData });
    const data = await res.json();
    if (!data.success) {
      alert('Falha no upload: ' + (data.error || 'erro desconhecido'));
    }
  } catch (err) {
    alert('Falha no upload: ' + err.message);
  } finally {
    fetchFiles();
  }
}

async function deleteItem(node) {
  const label = node.type === 'folder' ? `a pasta "${node.name}" e todo o seu conteúdo` : `"${node.name}"`;
  if (!confirm(`Remover ${label}?`)) return;
  try {
    await fetch(api('/delete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: node.path }),
    });
  } finally {
    fetchFiles();
  }
}

async function renameItem(node) {
  const newName = prompt('Novo nome:', node.name);
  if (!newName || newName === node.name) return;
  try {
    const res = await fetch(api('/rename'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: node.path, newName }),
    });
    const data = await res.json();
    if (!data.success) {
      alert('Falha ao renomear: ' + (data.error || 'erro desconhecido'));
    }
  } finally {
    fetchFiles();
  }
}

async function createFolder() {
  const name = prompt('Nome da nova pasta (ex.: imagens ou imagens/graficos):');
  if (!name) return;
  try {
    const res = await fetch(api('/folders'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: name }),
    });
    const data = await res.json();
    if (!data.success) {
      alert('Falha ao criar pasta: ' + (data.error || 'erro desconhecido'));
    }
  } finally {
    fetchFiles();
  }
}

fileInput.addEventListener('change', () => {
  uploadFiles(fileInput.files, pendingUploadFolder);
  fileInput.value = '';
  pendingUploadFolder = '';
});

document.getElementById('upload-root-btn').addEventListener('click', () => {
  pendingUploadFolder = '';
});

document.getElementById('new-folder-btn').addEventListener('click', createFolder);

fileSidebar.addEventListener('dragover', (e) => {
  e.preventDefault();
  fileSidebar.classList.add('drag-over');
});
fileSidebar.addEventListener('dragleave', () => {
  fileSidebar.classList.remove('drag-over');
});
fileSidebar.addEventListener('drop', (e) => {
  e.preventDefault();
  fileSidebar.classList.remove('drag-over');
  uploadFiles(e.dataTransfer.files, '');
});

// ------------------------------------------------------------------
// AI writing assistant: a chat sidebar backed by POST /chat, which proxies
// to the Anthropic API server-side (the key never reaches the browser).
// The assistant can read and search the whole project and change files
// through tools; each step streams back as a `tool` event and is shown
// inline, with "Desfazer" on every change it made. Each message also
// sends the relative path of whatever file is currently open
// (`currentFile`), so the server can attach its content as context.
// ------------------------------------------------------------------

const chatToggleBtn = document.getElementById('chat-toggle-btn');
const chatPanel = document.getElementById('chat-panel');
const chatCloseBtn = document.getElementById('chat-close-btn');
const chatMessagesEl = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');

const chatHistory = []; // { role: 'user' | 'assistant', content }
let chatStreaming = false;

chatToggleBtn.addEventListener('click', () => {
  chatPanel.classList.toggle('open');
  if (chatPanel.classList.contains('open')) chatInput.focus();
});
chatCloseBtn.addEventListener('click', () => chatPanel.classList.remove('open'));

function appendChatMessage(className, text) {
  const el = document.createElement('div');
  el.className = `chat-msg ${className}`;
  el.textContent = text;
  chatMessagesEl.appendChild(el);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  return el;
}

// Minimal fenced-code-block rendering (```lang ... ```) so LaTeX snippets
// show up monospaced — not a full markdown parser, just enough for that.
function renderChatText(el, text) {
  el.innerHTML = '';
  const parts = text.split(/```[a-z]*\n([\s\S]*?)```/g);
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      if (part) el.appendChild(document.createTextNode(part));
    } else {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = part;
      pre.appendChild(code);
      el.appendChild(pre);
    }
  });
}

function toolLabel(tool) {
  const p = tool.path || '';
  // Leitura em outro projeto do usuário: mostra de qual.
  const em = tool.project ? ` em “${tool.project}”` : '';
  switch (tool.name) {
    case 'list_projects':
      return '🗂️ Viu a lista de projetos';
    case 'search_network_papers':
      return `🌐 Buscou na rede KORPUS “${tool.detail || ''}”`;
    case 'read_network_paper':
      return `📑 Leu da rede: ${tool.detail || ''}`;
    case 'list_files':
      return tool.project ? `📂 Viu os arquivos de “${tool.project}”` : '📂 Viu os arquivos do projeto';
    case 'read_file':
      return `📖 Leu ${p}${em}`;
    case 'search_project':
      return `🔎 Buscou “${tool.detail || ''}”${em}`;
    case 'edit_file':
      return `✏️ Alterou ${p}`;
    case 'create_file':
      return `📄 Criou ${p}`;
    default:
      return tool.name;
  }
}

function toolErrorLabel(tool) {
  const p = tool.path || '';
  const what = {
    read_file: `Não conseguiu ler ${p}`,
    search_project: 'A busca falhou',
    search_network_papers: 'A busca na rede KORPUS falhou',
    read_network_paper: 'Não conseguiu ler o paper da rede',
    edit_file: `Não conseguiu alterar ${p}`,
    create_file: `Não conseguiu criar ${p}`,
  }[tool.name];
  return what ? `⚠️ ${what}: ${tool.detail || 'erro'}` : `⚠️ ${tool.detail || 'erro'}`;
}

// "Working" indicator kept as the last child of the assistant's reply for
// as long as the request runs — the model can go quiet for a while between
// steps (reading files, writing a long edit), and without it the chat looks
// frozen. Its text follows what the assistant is doing right now.
function createWorkingIndicator() {
  const el = document.createElement('div');
  el.className = 'chat-working';
  const dots = document.createElement('span');
  dots.className = 'chat-working-dots';
  dots.innerHTML = '<i></i><i></i><i></i>';
  const label = document.createElement('span');
  label.className = 'chat-working-label';
  label.textContent = 'Pensando…';
  el.append(dots, label);
  return { el, setLabel: (text) => (label.textContent = text) };
}

async function undoAiEdit(editId, row, undoBtn) {
  undoBtn.disabled = true;
  try {
    const res = await fetch(api('/chat/undo'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editId }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'erro desconhecido');
    row.classList.add('undone');
    undoBtn.textContent = 'Desfeito';
    fetchFiles();
  } catch (err) {
    undoBtn.disabled = false;
    alert('Não foi possível desfazer: ' + err.message);
  }
}

function buildToolRow(tool) {
  const row = document.createElement('div');
  row.className = 'chat-tool' + (tool.status === 'error' ? ' error' : '') + (tool.editId ? ' change' : '');
  const label = document.createElement('span');
  label.className = 'chat-tool-label';
  label.textContent = tool.status === 'error' ? toolErrorLabel(tool) : toolLabel(tool);
  row.appendChild(label);

  if (tool.editId) {
    if (tool.path && EDITABLE_EXT.includes(extOf(tool.path))) {
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'chat-tool-btn';
      openBtn.textContent = 'Abrir';
      openBtn.addEventListener('click', () => connectToFile(tool.path));
      row.appendChild(openBtn);
    }
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'chat-tool-btn';
    undoBtn.textContent = 'Desfazer';
    undoBtn.addEventListener('click', () => undoAiEdit(tool.editId, row, undoBtn));
    row.appendChild(undoBtn);
  }
  return row;
}

async function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text || chatStreaming) return;
  chatInput.value = '';
  appendChatMessage('user', text);
  chatHistory.push({ role: 'user', content: text });

  // One assistant message can interleave text with tool steps, so it's
  // rendered as a sequence of segments: a text bubble per stretch of
  // text and a row per tool call.
  const assistantEl = appendChatMessage('assistant', '');
  const working = createWorkingIndicator();
  assistantEl.appendChild(working.el);
  // New segments go right before the indicator so it stays at the bottom.
  const appendSegment = (el) => assistantEl.insertBefore(el, working.el);
  let textEl = null;
  let segmentText = '';
  chatStreaming = true;
  chatSendBtn.disabled = true;

  let assistantText = '';
  const changes = [];
  try {
    const res = await fetch(api('/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatHistory, file: currentFile }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Erro ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const evt of events) {
        const line = evt.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]' || !payload) continue;
        const parsed = JSON.parse(payload);
        if (parsed.error) {
          appendSegment(buildToolRow({ name: 'erro', status: 'error', detail: parsed.error }));
          textEl = null;
        } else if (parsed.tool) {
          appendSegment(buildToolRow(parsed.tool));
          if (parsed.tool.editId) changes.push(toolLabel(parsed.tool).replace(/^\S+\s/, ''));
          textEl = null;
          working.setLabel(parsed.tool.editId ? 'Continuando…' : 'Analisando o projeto…');
        } else if (parsed.text) {
          working.setLabel('Escrevendo…');
          if (!textEl) {
            textEl = document.createElement('div');
            textEl.className = 'chat-text';
            appendSegment(textEl);
            segmentText = '';
            if (assistantText) assistantText += '\n\n';
          }
          segmentText += parsed.text;
          assistantText += parsed.text;
          renderChatText(textEl, segmentText);
        }
        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
      }
    }
    // The server only receives text history, so note what was changed —
    // otherwise the next turn wouldn't know its earlier edits happened.
    const record = changes.length ? `${assistantText}\n\n[Alterações feitas: ${changes.join('; ')}]` : assistantText;
    chatHistory.push({ role: 'assistant', content: record.trim() || '(sem resposta)' });
    if (changes.length) fetchFiles();
  } catch (err) {
    working.el.remove();
    if (!assistantEl.childNodes.length) assistantEl.remove();
    appendChatMessage('error', assistantText ? `[interrompido: ${err.message}]` : `Erro: ${err.message}`);
  } finally {
    working.el.remove();
    chatStreaming = false;
    chatSendBtn.disabled = false;
  }
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendChatMessage();
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

logPanel.classList.add('collapsed');
loadProjectName();
fetchFiles();
subscribeToCompileEvents();

// --- Rede KORPUS: sincronizar este projeto ----------------------------------
// Rascunho nunca sai; "Em submissão" e "Publicado" são enviados com um clique.
// A rede gera o resumo a partir do texto e o descarta.
const redePanel = document.getElementById('rede-panel');
const redeBody = document.getElementById('rede-body');
let redeState = null;

function redeAgo(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(min)) return '';
  return min < 1 ? 'agora' : min < 60 ? `há ${min} min` : min < 1440 ? `há ${Math.round(min / 60)} h` : `há ${Math.round(min / 1440)} dias`;
}
const redeEsc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderRede(msg) {
  const st = redeState;
  if (!st) { redeBody.innerHTML = '<p class="rede-muted">Carregando…</p>'; return; }
  if (!st.enabled) {
    redeBody.innerHTML = '<p class="rede-muted">A rede KORPUS não está configurada neste servidor (KORPUS_URL e KORPUS_TOKEN no .env).</p>';
    return;
  }
  const net = st.network;
  const inNet = !!st.syncedAt && st.status !== 'draft';
  const stateLine = !inNet ? '<div class="rede-state">Não está na rede</div>'
    : net && net.summaryStatus === 'pending' ? `<div class="rede-state wait">Na rede · gerando o resumo…</div>`
    : `<div class="rede-state on">Na rede · enviado ${redeAgo(st.syncedAt)}</div>`;
  const pv = st.preview || {};
  const opt = (v, t, d) => `<label><input type="radio" name="rede-status" value="${v}" ${st.status === v ? 'checked' : ''}><div><b>${t}</b><span>${d}</span></div></label>`;
  redeBody.innerHTML = `
    ${stateLine}
    ${inNet && st.changed ? '<div class="rede-warn">Há alterações desde o último envio. Atualize para a rede ver a versão nova.</div>' : ''}
    <div class="rede-box">
      <h4>O que será enviado</h4>
      ${st.previewError ? `<p class="rede-err">${redeEsc(st.previewError)}</p>` : `
        <div class="t">${redeEsc(pv.title || '(sem \\title no documento)')}</div>
        <div class="rede-muted">${redeEsc((pv.authors || []).join(', ') || 'autores não identificados')}</div>
        ${pv.keywords && pv.keywords.length ? `<div class="rede-muted">${redeEsc(pv.keywords.join(' · '))}</div>` : ''}
        <div class="rede-muted">${pv.files} arquivo(s) · ${Number(pv.chars || 0).toLocaleString('pt-BR')} caracteres${pv.truncated ? ' (será cortado)' : ''}</div>`}
    </div>
    <div class="rede-opts">
      ${opt('draft', 'Rascunho', 'não sai daqui')}
      ${opt('submission', 'Em submissão', 'entra na rede com um clique')}
      ${opt('published', 'Publicado', 'entra na rede com um clique')}
    </div>
    ${st.autor ? '' : '<p class="rede-err">Configure KORPUS_AUTOR_NOME e KORPUS_AUTOR_EMAIL no .env do LaTeX Live para enviar.</p>'}
    <button type="button" class="btn btn-primary rede-go" id="rede-go"></button>
    ${msg ? `<p class="${msg.error ? 'rede-err' : 'rede-muted'}">${redeEsc(msg.text)}</p>` : ''}
    <p class="rede-muted">Na rede ficam os metadados e o resumo feito pela IA; o texto completo é descartado. Voltar a rascunho tira o projeto da rede.</p>`;
  const go = document.getElementById('rede-go');
  const chosen = () => (redeBody.querySelector('input[name=rede-status]:checked') || {}).value || 'draft';
  const label = () => {
    const c = chosen();
    if (c === 'draft') return inNet ? ['Tirar da rede', false] : ['Rascunhos não são enviados', true];
    if (!st.autor) return ['Enviar para a rede', true];
    return [inNet ? (st.changed || c !== st.status ? 'Atualizar na rede' : 'Enviar de novo') : 'Enviar para a rede', false];
  };
  const refresh = () => { const [t, dis] = label(); go.textContent = t; go.disabled = dis; };
  redeBody.querySelectorAll('input[name=rede-status]').forEach((r) => r.addEventListener('change', refresh));
  refresh();
  go.addEventListener('click', async () => {
    go.disabled = true; go.textContent = 'Enviando…';
    try {
      const res = await fetch(api('/korpus'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: chosen() }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const text = chosen() === 'draft' ? (data.removed ? 'Projeto tirado da rede.' : 'Marcado como rascunho.')
        : data.action === 'unchanged' ? 'A rede já tinha esta versão.' : 'Enviado. A rede está gerando o resumo.';
      await loadRede({ text });
    } catch (err) {
      renderRede({ error: true, text: err.message });
    }
  });
}

async function loadRede(msg) {
  try {
    const res = await fetch(api('/korpus'));
    redeState = await res.json();
  } catch (err) {
    redeState = { enabled: false };
  }
  renderRede(msg);
}

document.getElementById('rede-toggle-btn').addEventListener('click', () => {
  const open = !redePanel.classList.contains('open');
  redePanel.classList.toggle('open', open);
  if (open) { document.getElementById('chat-panel').classList.remove('open'); redeState = null; renderRede(); loadRede(); }
});
document.getElementById('rede-close-btn').addEventListener('click', () => redePanel.classList.remove('open'));
document.getElementById('chat-toggle-btn').addEventListener('click', () => redePanel.classList.remove('open'));
