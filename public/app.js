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
const api = (p) => `/api/projects/${encodeURIComponent(PROJECT_ID)}${p}`;

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
    url: `${wsProtocol}//${location.host}/collab`,
    name: `${PROJECT_ID}:${relPath}`,
    document: ydoc,
    onSynced: () => {
      if (isMain && !firstSyncHandled) {
        firstSyncHandled = true;
        compile();
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

async function handleCompileResult(result) {
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
  setupPageObservers(token);
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

function snippetFor(relPath) {
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

logPanel.classList.add('collapsed');
loadProjectName();
fetchFiles();
