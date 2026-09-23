const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const { Hocuspocus } = require('@hocuspocus/server');
const nodeAdapter = require('crossws/adapters/node').default;
const synctexParser = require('./lib/synctex-parser');

const PORT = process.env.PORT || 4173;
const ROOT_DIR = __dirname;
// Overridable so a deployment with persistent storage (e.g. a mounted
// volume on a host like Hugging Face Spaces) can point this outside the
// container's ephemeral disk and survive restarts.
const PROJECTS_ROOT = process.env.PROJECTS_DIR || path.join(ROOT_DIR, 'projects');

// --- Simple shared-password gate -------------------------------------------
// Off by default (matches the previous no-login local behavior). Set
// SITE_PASSWORD to require it — meant for when this is deployed somewhere
// reachable by other people, not as strong access control on its own.
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const AUTH_COOKIE = 'latex_live_auth';

function authToken() {
  return crypto.createHmac('sha256', AUTH_SECRET).update('authenticated').digest('hex');
}

function passwordsMatch(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
const LEGACY_PROJECT_DIR = path.join(ROOT_DIR, 'project');
const LEGACY_OUTPUT_DIR = path.join(ROOT_DIR, 'output');
const DEFAULT_MAIN_FILE = 'main.tex';
const DEFAULT_PROJECT_NAME = 'Documento sem título';

function defaultTexTemplate(name) {
  const safeTitle = String(name || DEFAULT_PROJECT_NAME).replace(/[{}\\]/g, '');
  return `\\documentclass{article}
\\usepackage[utf8]{inputenc}

\\title{${safeTitle}}
\\author{}
\\date{\\today}

\\begin{document}

\\maketitle

\\end{document}
`;
}

// Large documents (many chapters, high-res figures, long bibliographies) can
// take a while to typeset and involve big assets — defaults here are generous
// on purpose, and can be raised further via env vars for very heavy projects.
const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS) || 180000; // 3 min
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 200;
const MAX_ZIP_MB = Number(process.env.MAX_ZIP_MB) || 500;
const MAX_LOG_CHARS = 300_000;

fs.mkdirSync(PROJECTS_ROOT, { recursive: true });

// --- One-time migration: this app used to manage a single project living in
// ./project (+ ./output for its compiled PDF). Fold that into the new
// projects/<id>/ layout instead of orphaning whatever the user already built.
function migrateLegacyProjectIfNeeded() {
  const alreadyMigrated = fs.readdirSync(PROJECTS_ROOT).length > 0;
  if (alreadyMigrated) return;
  if (!fs.existsSync(path.join(LEGACY_PROJECT_DIR, DEFAULT_MAIN_FILE))) return;

  const id = crypto.randomUUID();
  const dir = path.join(PROJECTS_ROOT, id);
  fs.renameSync(LEGACY_PROJECT_DIR, dir);

  const outDir = path.join(dir, '.output');
  fs.mkdirSync(outDir, { recursive: true });
  const legacyPdf = path.join(LEGACY_OUTPUT_DIR, 'main.pdf');
  if (fs.existsSync(legacyPdf)) {
    fs.renameSync(legacyPdf, path.join(outDir, 'main.pdf'));
  }
  if (fs.existsSync(LEGACY_OUTPUT_DIR)) {
    fs.rmSync(LEGACY_OUTPUT_DIR, { recursive: true, force: true });
  }

  const metaPath = path.join(dir, '.project.json');
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    // no pre-existing metadata — fine
  }
  const now = new Date().toISOString();
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        name: existing.name || DEFAULT_PROJECT_NAME,
        mainFile: DEFAULT_MAIN_FILE,
        createdAt: existing.createdAt || now,
        updatedAt: now,
      },
      null,
      2
    )
  );
  console.log(`Projeto existente migrado para projects/${id}`);
}

migrateLegacyProjectIfNeeded();

// --- Per-project path & metadata helpers -----------------------------------

function isValidProjectId(id) {
  return typeof id === 'string' && /^[a-f0-9-]{8,64}$/i.test(id);
}

function projectDir(id) {
  return path.join(PROJECTS_ROOT, id);
}

function outputDir(id) {
  return path.join(projectDir(id), '.output');
}

function outputBase(id) {
  // tectonic names its output after the input file's basename (thesis.tex ->
  // thesis.pdf), not always "main" — matters once mainFile isn't literally
  // main.tex (imported projects can have any entry-point name).
  const mainRel = getMainFileRel(id);
  return path.basename(mainRel, path.extname(mainRel));
}

function pdfPath(id) {
  return path.join(outputDir(id), `${outputBase(id)}.pdf`);
}

function synctexPath(id) {
  return path.join(outputDir(id), `${outputBase(id)}.synctex.gz`);
}

function metaPath(id) {
  return path.join(projectDir(id), '.project.json');
}

function readProjectMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  } catch {
    return {};
  }
}

function writeProjectMeta(id, meta) {
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
}

function touchProject(id) {
  const meta = readProjectMeta(id);
  meta.updatedAt = new Date().toISOString();
  writeProjectMeta(id, meta);
}

function getMainFileRel(id) {
  return readProjectMeta(id).mainFile || DEFAULT_MAIN_FILE;
}

function mainFileAbs(id) {
  return path.join(projectDir(id), getMainFileRel(id));
}

function listProjects() {
  return fs
    .readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const meta = readProjectMeta(e.name);
      return {
        id: e.name,
        name: meta.name || DEFAULT_PROJECT_NAME,
        updatedAt: meta.updatedAt || meta.createdAt || null,
      };
    })
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

function safeFilename(name) {
  let base = path.basename(String(name || '')).replace(/[\\/\x00-\x1f]/g, '_');
  if (!base || base === '.' || base === '..') base = 'arquivo';
  return base;
}

// multer/busboy decode multipart headers as latin1, so UTF-8 filenames
// (e.g. accented Portuguese names) arrive mojibake'd — re-decode before
// sanitizing.
function safeUploadFilename(originalname) {
  const fixed = Buffer.from(String(originalname || ''), 'latin1').toString('utf8');
  return safeFilename(fixed);
}

// Resolves a user-supplied relative path (e.g. "imagens/graficos") to a safe
// absolute path inside a project's directory: each segment is sanitized
// individually and "." / ".." segments are dropped, so the result can never
// escape it.
function resolveProjectPath(id, relPath) {
  const base = projectDir(id);
  const segments = String(relPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map(safeFilename);
  const rel = segments.join('/');
  const abs = path.join(base, ...segments);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('Caminho inválido.');
  }
  return { abs, rel, segments };
}

function buildFileTree(id, dirAbs, dirRel) {
  const mainRel = getMainFileRel(id);
  const entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  const nodes = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
    if (rel === mainRel) continue;
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      nodes.push({ type: 'folder', name: entry.name, path: rel, children: buildFileTree(id, abs, rel) });
    } else if (entry.isFile()) {
      nodes.push({ type: 'file', name: entry.name, path: rel, size: fs.statSync(abs).size });
    }
  }
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

// --- Compile queues: one per project, each always compiling the most
// recently submitted content and coalescing requests that arrive while a
// compile for that project is already running. Keeping this per-project
// means compiling one project never blocks or races with another. ---
const queues = new Map(); // id -> { latestContent, waiters, running }

// SSE subscribers per project — every connected client (whether or not it's
// the one whose edit triggered this particular compile) gets the result
// pushed here. This is what lets a second/third viewer's preview update
// even when their own browser tab never personally called /compile: with
// several people editing the same live document, every one of them fires a
// compile on each change (see app.js's `cm.on('change', scheduleCompile)`),
// so whoever's request actually reaches the front of the queue "wins" and
// the others would otherwise just wait on their own now-redundant request —
// which, over a flaky connection (e.g. a free Cloudflare tunnel), can hang
// long enough to look stuck. Broadcasting means nobody's view depends on
// their own request making it back in one piece.
const compileSubscribers = new Map(); // id -> Set<res>

function broadcastCompileResult(id, result) {
  const subs = compileSubscribers.get(id);
  if (!subs || subs.size === 0) return;
  const payload = `data: ${JSON.stringify(result)}\n\n`;
  for (const res of subs) {
    try {
      res.write(payload);
    } catch {
      subs.delete(res);
    }
  }
}

function getQueue(id) {
  let q = queues.get(id);
  if (!q) {
    q = { latestContent: null, waiters: [], running: false, seq: 0 };
    queues.set(id, q);
  }
  return q;
}

function requestCompile(id, content) {
  const q = getQueue(id);
  q.latestContent = content;
  return new Promise((resolve, reject) => {
    q.waiters.push({ resolve, reject });
    if (!q.running) processQueue(id);
  });
}

async function processQueue(id) {
  const q = getQueue(id);
  q.running = true;
  while (q.waiters.length > 0) {
    const contentToCompile = q.latestContent;
    const currentWaiters = q.waiters;
    q.waiters = [];
    try {
      const result = await runCompile(id, contentToCompile);
      result.seq = ++q.seq;
      currentWaiters.forEach((w) => w.resolve(result));
      broadcastCompileResult(id, result);
    } catch (err) {
      const result = { success: false, log: String(err), seq: ++q.seq };
      currentWaiters.forEach((w) => w.reject(err));
      broadcastCompileResult(id, result);
    }
  }
  q.running = false;
}

function runCompile(id, content) {
  return new Promise((resolve) => {
    const texPath = mainFileAbs(id);
    // The main file is now kept up to date continuously by the Yjs
    // collaboration layer (onStoreDocument) — content is only written here
    // when a caller explicitly passes it (e.g. a non-collaborative client);
    // otherwise this just (re)compiles whatever's already on disk.
    if (typeof content === 'string') {
      fs.mkdirSync(path.dirname(texPath), { recursive: true });
      fs.writeFileSync(texPath, content, 'utf8');
    }
    const outDir = outputDir(id);
    fs.mkdirSync(outDir, { recursive: true });

    // cwd is the main file's own directory (not always the project root) so
    // that \input/\includegraphics paths inside imported projects — which
    // may nest their main file in a subfolder — resolve exactly as the
    // original project intended.
    const proc = spawn('tectonic', ['--synctex', '--outdir', outDir, texPath], {
      cwd: path.dirname(texPath),
    });

    let log = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        proc.kill('SIGKILL');
        log += '\n[compilação cancelada: tempo limite excedido]';
      }
    }, COMPILE_TIMEOUT_MS);

    proc.stdout.on('data', (d) => (log += d.toString()));
    proc.stderr.on('data', (d) => (log += d.toString()));

    proc.on('error', (err) => {
      finished = true;
      clearTimeout(timer);
      resolve({
        success: false,
        log: `Não foi possível executar o "tectonic". Verifique se está instalado e no PATH.\n${err.message}`,
      });
    });

    proc.on('close', (code) => {
      finished = true;
      clearTimeout(timer);
      if (log.length > MAX_LOG_CHARS) {
        log = log.slice(0, MAX_LOG_CHARS) + '\n\n[log truncado — saída muito longa]';
      }
      touchProject(id);
      resolve({ success: code === 0 && fs.existsSync(pdfPath(id)), log });
    });
  });
}

// --- Uploads ----------------------------------------------------------------

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        const { abs } = resolveProjectPath(req.params.id, req.body.folder || '');
        fs.mkdirSync(abs, { recursive: true });
        cb(null, abs);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => cb(null, safeUploadFilename(file.originalname)),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const folder = req.body.folder || '';
    const rel = folder ? `${folder}/${safeUploadFilename(file.originalname)}` : safeUploadFilename(file.originalname);
    if (rel === getMainFileRel(req.params.id)) {
      return cb(new Error(`"${rel}" é o arquivo principal e é gerenciado pelo editor.`));
    }
    cb(null, true);
  },
});

const zipUpload = multer({ dest: os.tmpdir(), limits: { fileSize: MAX_ZIP_MB * 1024 * 1024 } });

// Some zip exporters wrap the whole project inside one top-level folder
// (e.g. "MeuProjeto/main.tex" instead of "main.tex"). Flatten that away so
// the project root ends up holding the actual files.
function flattenSingleRootFolder(dir) {
  for (let i = 0; i < 5; i++) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
    if (entries.length !== 1 || !entries[0].isDirectory()) return;
    const wrapper = path.join(dir, entries[0].name);
    for (const child of fs.readdirSync(wrapper)) {
      fs.renameSync(path.join(wrapper, child), path.join(dir, child));
    }
    fs.rmdirSync(wrapper);
  }
}

// Finds the best candidate to treat as the project's main .tex file: an
// existing root-level main.tex wins outright; otherwise every .tex file is
// scanned for \documentclass and the shallowest / most main-sounding match
// is picked. Mirrors what you'd otherwise set by hand in Overleaf's
// "main document" project setting.
function detectMainFile(dir) {
  const rootEntries = fs.readdirSync(dir, { withFileTypes: true });
  if (rootEntries.some((e) => e.isFile() && e.name === DEFAULT_MAIN_FILE)) {
    return { mainFile: DEFAULT_MAIN_FILE, warning: null };
  }

  const candidates = [];
  (function walk(curDir, relDir) {
    for (const e of fs.readdirSync(curDir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const abs = path.join(curDir, e.name);
      if (e.isDirectory()) {
        walk(abs, rel);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.tex')) {
        const content = fs.readFileSync(abs, 'utf8');
        if (/\\documentclass/.test(content)) candidates.push(rel);
      }
    }
  })(dir, '');

  if (candidates.length === 0) {
    fs.writeFileSync(path.join(dir, DEFAULT_MAIN_FILE), defaultTexTemplate());
    return {
      mainFile: DEFAULT_MAIN_FILE,
      warning: 'Não encontramos nenhum arquivo .tex com \\documentclass no zip; criamos um main.tex em branco.',
    };
  }

  candidates.sort((a, b) => {
    const depthDiff = a.split('/').length - b.split('/').length;
    if (depthDiff !== 0) return depthDiff;
    const scoreOf = (p) => (/main|thesis|dissert|tese|monografia|artigo/i.test(p) ? 0 : 1);
    return scoreOf(a) - scoreOf(b);
  });

  const chosen = candidates[0];
  const warning =
    candidates.length > 1
      ? `Vários arquivos .tex com \\documentclass foram encontrados; "${chosen}" foi escolhido como principal.`
      : `"${chosen}" foi identificado como o arquivo principal.`;
  return { mainFile: chosen, warning };
}

// --- App ---------------------------------------------------------------------

const app = express();
app.use(cookieParser());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  if (!SITE_PASSWORD) return next(); // gate disabled — local/dev default
  if (req.path === '/login') return next();
  if (req.cookies[AUTH_COOKIE] === authToken()) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, error: 'Não autenticado.' });
  }
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  if (!SITE_PASSWORD || passwordsMatch((req.body || {}).password || '', SITE_PASSWORD)) {
    res.cookie(AUTH_COOKIE, authToken(), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE);
  res.redirect('/login');
});

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.param('id', (req, res, next, id) => {
  if (!isValidProjectId(id) || !fs.existsSync(projectDir(id))) {
    return res.status(404).json({ success: false, error: 'Projeto não encontrado.' });
  }
  next();
});

// --- Dashboard-level routes ---

app.get('/api/projects', (req, res) => {
  res.json({ projects: listProjects() });
});

app.post('/api/projects', (req, res) => {
  const name = (req.body && req.body.name && req.body.name.trim()) || DEFAULT_PROJECT_NAME;
  const id = crypto.randomUUID();
  const dir = projectDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, DEFAULT_MAIN_FILE), defaultTexTemplate(name));
  const now = new Date().toISOString();
  writeProjectMeta(id, { name, mainFile: DEFAULT_MAIN_FILE, createdAt: now, updatedAt: now });
  res.json({ success: true, id, name });
});

app.post('/api/projects/import', (req, res) => {
  zipUpload.single('zip')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, error: err.message });
    if (!req.file) return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado.' });

    const id = crypto.randomUUID();
    const dir = projectDir(id);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const zip = new AdmZip(req.file.path);
      zip.extractAllTo(dir, true);
      flattenSingleRootFolder(dir);
      const { mainFile, warning } = detectMainFile(dir);

      const fallbackName = safeUploadFilename(req.file.originalname).replace(/\.zip$/i, '') || DEFAULT_PROJECT_NAME;
      const name = ((req.body && req.body.name) || fallbackName).trim() || DEFAULT_PROJECT_NAME;
      const now = new Date().toISOString();
      writeProjectMeta(id, { name, mainFile, createdAt: now, updatedAt: now });

      res.json({ success: true, id, name, mainFile, warning: warning || null });
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      res.status(400).json({ success: false, error: `Falha ao importar o zip: ${e.message}` });
    } finally {
      fs.unlink(req.file.path, () => {});
    }
  });
});

app.put('/api/projects/:id', (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, error: 'Nome inválido.' });
  }
  const meta = readProjectMeta(req.params.id);
  meta.name = name.trim().slice(0, 120);
  writeProjectMeta(req.params.id, meta);
  res.json({ success: true, name: meta.name });
});

app.delete('/api/projects/:id', (req, res) => {
  fs.rmSync(projectDir(req.params.id), { recursive: true, force: true });
  res.json({ success: true });
});

app.get('/api/projects/:id', (req, res) => {
  const meta = readProjectMeta(req.params.id);
  res.json({ id: req.params.id, name: meta.name || DEFAULT_PROJECT_NAME, mainFile: meta.mainFile || DEFAULT_MAIN_FILE });
});

// --- Per-project routes ---

app.get('/api/projects/:id/document', (req, res) => {
  const texPath = mainFileAbs(req.params.id);
  const content = fs.existsSync(texPath) ? fs.readFileSync(texPath, 'utf8') : '';
  res.json({ content, mainFile: getMainFileRel(req.params.id) });
});

app.get('/api/projects/:id/files', (req, res) => {
  res.json({ tree: buildFileTree(req.params.id, projectDir(req.params.id), '') });
});

app.post('/api/projects/:id/files', (req, res) => {
  // multer reads req.body fields as it parses the multipart stream, so the
  // "folder" field must be appended before the file parts on the client.
  upload.array('files', 200)(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    touchProject(req.params.id);
    res.json({ success: true, files: (req.files || []).map((f) => f.filename) });
  });
});

app.post('/api/projects/:id/folders', (req, res) => {
  try {
    const { abs, rel } = resolveProjectPath(req.params.id, (req.body || {}).path);
    if (!rel) return res.status(400).json({ success: false, error: 'Nome da pasta inválido.' });
    if (fs.existsSync(abs)) {
      return res.status(400).json({ success: false, error: 'Já existe um item com esse nome.' });
    }
    fs.mkdirSync(abs, { recursive: true });
    touchProject(req.params.id);
    res.json({ success: true, path: rel });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/projects/:id/rename', (req, res) => {
  try {
    const { id } = req.params;
    const { path: fromPath, newName } = req.body || {};
    const { abs: fromAbs, rel: fromRel, segments } = resolveProjectPath(id, fromPath);
    if (!fromRel || fromRel === getMainFileRel(id)) {
      return res.status(400).json({ success: false, error: 'Caminho inválido.' });
    }
    if (!fs.existsSync(fromAbs)) {
      return res.status(404).json({ success: false, error: 'Não encontrado.' });
    }
    const cleanName = safeFilename(newName);
    const parentSegments = segments.slice(0, -1);
    const toRel = [...parentSegments, cleanName].join('/');
    if (toRel === getMainFileRel(id)) {
      return res.status(400).json({ success: false, error: 'Esse nome é reservado para o arquivo principal.' });
    }
    const toAbs = path.join(projectDir(id), ...parentSegments, cleanName);
    if (toAbs !== fromAbs && fs.existsSync(toAbs)) {
      return res.status(400).json({ success: false, error: 'Já existe um item com esse nome.' });
    }
    fs.renameSync(fromAbs, toAbs);
    touchProject(id);
    res.json({ success: true, path: toRel });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/projects/:id/delete', (req, res) => {
  try {
    const { id } = req.params;
    const { abs, rel } = resolveProjectPath(id, (req.body || {}).path);
    if (!rel || rel === getMainFileRel(id)) {
      return res.status(400).json({ success: false, error: 'Caminho inválido.' });
    }
    if (fs.existsSync(abs)) {
      fs.rmSync(abs, { recursive: true, force: true });
    }
    touchProject(id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/projects/:id/compile', async (req, res) => {
  const { content } = req.body || {};
  try {
    const result = await requestCompile(req.params.id, typeof content === 'string' ? content : undefined);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, log: String(err) });
  }
});

app.get('/api/projects/:id/output.pdf', (req, res) => {
  const file = pdfPath(req.params.id);
  if (!fs.existsSync(file)) {
    return res.status(404).send('PDF ainda não gerado.');
  }
  res.set('Cache-Control', 'no-store');
  res.sendFile(file);
});

// Collects glyph-level SyncTeX records (leaf `elements`, recursing through
// container `blocks`) — precise (x, y) -> source line hits. `includeBlocks`
// is a coarser fallback for pages with little text (e.g. mostly a figure).
function flattenSyncTex(node, acc, includeBlocks) {
  if (!node) return;
  (node.elements || []).forEach((e) => {
    if (e.line != null && e.left != null && e.bottom != null) {
      acc.push({ line: e.line, fileName: e.file && e.file.name, left: e.left, bottom: e.bottom });
    }
  });
  if (includeBlocks && node.line != null && node.left != null && node.bottom != null) {
    acc.push({ line: node.line, fileName: node.file && node.file.name, left: node.left, bottom: node.bottom });
  }
  (node.blocks || []).forEach((b) => flattenSyncTex(b, acc, includeBlocks));
}

// Push channel for compile results — see the comment above compileSubscribers.
app.get('/api/projects/:id/compile-events', (req, res) => {
  const id = req.params.id;
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(':ok\n\n'); // comment line — opens the stream immediately, no event

  let subs = compileSubscribers.get(id);
  if (!subs) {
    subs = new Set();
    compileSubscribers.set(id, subs);
  }
  subs.add(res);

  // Some proxies/tunnels close a connection they consider idle — a ping
  // comment every 20s (ignored by EventSource, since it has no "data:"
  // line) keeps bytes flowing so that doesn't happen mid-session.
  const heartbeat = setInterval(() => {
    try {
      res.write(':ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    subs.delete(res);
  });
});

app.post('/api/projects/:id/sync', (req, res) => {
  const { page, x, y } = req.body || {};
  const file = synctexPath(req.params.id);
  if (typeof page !== 'number' || typeof x !== 'number' || typeof y !== 'number') {
    return res.status(400).json({ success: false, error: 'Parâmetros inválidos.' });
  }
  if (!fs.existsSync(file)) {
    return res.status(404).json({ success: false, error: 'SyncTeX não disponível — compile o projeto de novo.' });
  }
  try {
    const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    const parsed = synctexParser.parseSyncTex(text);
    const pageData = parsed.pages[page];
    if (!pageData) return res.json({ success: false });

    let elements = [];
    (pageData.blocks || []).forEach((b) => flattenSyncTex(b, elements, false));
    if (elements.length === 0) {
      (pageData.blocks || []).forEach((b) => flattenSyncTex(b, elements, true));
    }
    if (elements.length === 0) return res.json({ success: false });

    let best = null;
    let bestDist = Infinity;
    for (const el of elements) {
      const dx = el.left - x;
      const dy = el.bottom - y;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = el;
      }
    }

    const mainBase = path.basename(getMainFileRel(req.params.id));
    res.json({
      success: true,
      file: best.fileName,
      line: best.line,
      isMainFile: best.fileName === mainBase,
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- AI writing assistant (Anthropic API) ------------------------------------
// Disabled until ANTHROPIC_API_KEY is set — the sidebar chat shows a message
// explaining that instead of failing. Model is fixed to Haiku: this app is
// shared by a handful of trusted people (the user + advisors) behind one
// password, so cost per message matters more than squeezing out the last bit
// of quality, and Haiku is already strong for LaTeX/writing help.
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const CHAT_MODEL = 'claude-haiku-4-5-20251001';
const CHAT_MAX_TOKENS = 1024;
const CHAT_RATE_LIMIT_PER_MIN = 20; // server-wide — guards against a runaway loop eating the budget, not against these specific trusted users

let chatRequestTimestamps = [];
function chatRateLimitExceeded() {
  const now = Date.now();
  chatRequestTimestamps = chatRequestTimestamps.filter((t) => now - t < 60_000);
  if (chatRequestTimestamps.length >= CHAT_RATE_LIMIT_PER_MIN) return true;
  chatRequestTimestamps.push(now);
  return false;
}

app.post('/api/projects/:id/chat', async (req, res) => {
  if (!anthropic) {
    return res.status(503).json({ error: 'Assistente de IA não configurado neste servidor (falta ANTHROPIC_API_KEY).' });
  }
  const { messages, file } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Nenhuma mensagem enviada.' });
  }
  if (chatRateLimitExceeded()) {
    return res.status(429).json({ error: 'Muitas mensagens em pouco tempo — espere um minuto e tente de novo.' });
  }

  let systemPrompt =
    'Você é um assistente de escrita acadêmica e LaTeX, integrado a um editor local chamado LaTeX Live. ' +
    'Responda em português do Brasil, de forma direta e concisa. Quando sugerir código LaTeX, use blocos de código.';
  if (typeof file === 'string') {
    try {
      const { abs, rel } = resolveProjectPath(req.params.id, file);
      if (rel && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const content = fs.readFileSync(abs, 'utf8').slice(0, 20_000);
        systemPrompt += `\n\nArquivo aberto no editor agora (${rel}):\n\`\`\`latex\n${content}\n\`\`\``;
      }
    } catch {
      // unknown/invalid file — just skip the extra context
    }
  }

  const safeMessages = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
  if (safeMessages.length === 0) {
    return res.status(400).json({ error: 'Nenhuma mensagem válida enviada.' });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const stream = anthropic.messages.stream({
    model: CHAT_MODEL,
    max_tokens: CHAT_MAX_TOKENS,
    system: systemPrompt,
    messages: safeMessages,
  });
  req.on('close', () => stream.abort());
  stream.on('text', (text) => {
    res.write(`data: ${JSON.stringify({ text })}\n\n`);
  });
  stream.on('error', (err) => {
    res.write(`data: ${JSON.stringify({ error: String((err && err.message) || err) })}\n\n`);
    res.end();
  });
  try {
    await stream.finalMessage();
  } catch {
    // already reported via the 'error' listener above
  }
  res.write('data: [DONE]\n\n');
  res.end();
});

// --- Real-time collaborative editing (Yjs via Hocuspocus) -------------------
// Yjs documents are named "<projectId>:<relative file path>", so any text
// file in a project — not just the main one — can be opened for live,
// persisted editing. Each is bridged to that exact file on disk: this keeps
// the file as the single source of truth, so compiling, downloading, and
// reopening a project later all keep working exactly as before — whether or
// not anyone happens to be connected right now.
const COLLAB_PATH = '/collab';

// Belt-and-braces guard, independent of *why* a Yjs document might end up
// duplicated (a stale browser tab reconnecting with old state after a
// server restart is the main known cause, but this stays useful regardless
// of the cause): refuse to persist content that structurally looks like
// itself repeated, rather than overwriting a good file on disk with a bad
// one. Returns a reason string when content looks corrupted, else null.
function detectCorruption(content, isMainFile) {
  if (isMainFile) {
    const documentclassCount = (content.match(/\\documentclass/g) || []).length;
    if (documentclassCount > 1) return `\\documentclass aparece ${documentclassCount}x`;
  }
  const lines = content.split('\n');
  let run = 1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && line === lines[i - 1].trim()) {
      run++;
      if (run >= 3) return `linha repetida ${run}x seguidas: "${line.slice(0, 60)}"`;
    } else {
      run = 1;
    }
  }

  // Catches a different shape of the same race: the whole document (or a
  // large chunk of it) copied as a second, separate block instead of
  // repeated line-by-line — e.g. a stale client's own already-synced
  // content merging back in on top of a freshly-seeded copy. A substantial
  // paragraph (text between blank lines) showing up twice, byte-for-byte,
  // isn't something real LaTeX content does by coincidence.
  const paragraphs = content.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length >= 80);
  const seenParagraphs = new Set();
  for (const p of paragraphs) {
    if (seenParagraphs.has(p)) return `trecho duplicado (${p.length} caracteres): "${p.slice(0, 60)}…"`;
    seenParagraphs.add(p);
  }
  return null;
}

function parseDocumentName(documentName) {
  const sep = String(documentName || '').indexOf(':');
  if (sep === -1) return null;
  const projectId = documentName.slice(0, sep);
  const relPath = documentName.slice(sep + 1);
  if (!isValidProjectId(projectId) || !fs.existsSync(projectDir(projectId))) return null;
  try {
    const { abs, rel } = resolveProjectPath(projectId, relPath);
    if (!rel) return null;
    return { projectId, relPath: rel, abs };
  } catch {
    return null;
  }
}

// A stale client reconnecting (e.g. after a server restart, or after this
// document was unloaded and reloaded) can race with the seed-from-disk
// below and produce duplicated content — the CRDT correctly keeps both
// independent insertions rather than recognizing them as "the same text".
// That's hard to fully rule out here, so `detectCorruption` in
// onStoreDocument is the real safety net: it refuses to ever persist the
// result to disk. Seeding must still run every time a genuinely empty
// Document is loaded (including after a legitimate unload+reload, e.g.
// switching back to a file nobody else has open) — a "seed only once per
// process" guard was tried here and caused exactly that regression.
const hocuspocus = new Hocuspocus({
  async onLoadDocument({ documentName, document }) {
    const target = parseDocumentName(documentName);
    if (!target) return;
    if (document.isEmpty('content')) {
      const content = fs.existsSync(target.abs) ? fs.readFileSync(target.abs, 'utf8') : '';
      document.getText('content').insert(0, content);
    }
  },
  async onStoreDocument({ documentName, document }) {
    const target = parseDocumentName(documentName);
    if (!target) return;
    const content = document.getText('content').toString();
    const reason = detectCorruption(content, target.relPath === getMainFileRel(target.projectId));
    if (reason) {
      console.error(`Recusando salvar ${documentName}: ${reason}`);
      return;
    }
    fs.mkdirSync(path.dirname(target.abs), { recursive: true });
    fs.writeFileSync(target.abs, content, 'utf8');
    touchProject(target.projectId);
  },
});

const collabAdapter = nodeAdapter({
  hooks: {
    open(peer) {
      peer._hocuspocus = hocuspocus.handleConnection(peer.websocket, peer.request);
    },
    message(peer, message) {
      peer._hocuspocus?.handleMessage(message.uint8Array());
    },
    close(peer, event) {
      peer._hocuspocus?.handleClose({ code: event.code, reason: event.reason });
    },
    error(peer, error) {
      console.error('Erro de WebSocket na colaboração:', error);
    },
  },
});

// WebSocket upgrades bypass Express entirely, so the SITE_PASSWORD gate
// (an app.use middleware) never sees them — check the same auth cookie here
// by hand so the collaboration channel isn't left open when everything else
// requires a password.
function isAuthenticatedUpgrade(req) {
  if (!SITE_PASSWORD) return true;
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`));
  return Boolean(match && match[1] === authToken());
}

const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith(COLLAB_PATH) || !isAuthenticatedUpgrade(req)) {
    socket.destroy();
    return;
  }
  collabAdapter.handleUpgrade(req, socket, head);
});

server.listen(PORT, () => {
  console.log(`LaTeX live editor rodando em http://localhost:${PORT}`);
});
