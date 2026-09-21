const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Hocuspocus } = require('@hocuspocus/server');
const nodeAdapter = require('crossws/adapters/node').default;

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

function pdfPath(id) {
  // tectonic names its output after the input file's basename (thesis.tex ->
  // thesis.pdf), not always "main.pdf" — matters once mainFile isn't
  // literally main.tex (imported projects can have any entry-point name).
  const mainRel = getMainFileRel(id);
  const base = path.basename(mainRel, path.extname(mainRel));
  return path.join(outputDir(id), `${base}.pdf`);
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

function getQueue(id) {
  let q = queues.get(id);
  if (!q) {
    q = { latestContent: null, waiters: [], running: false };
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
      currentWaiters.forEach((w) => w.resolve(result));
    } catch (err) {
      currentWaiters.forEach((w) => w.reject(err));
    }
  }
  q.running = false;
}

function runCompile(id, content) {
  return new Promise((resolve) => {
    const texPath = mainFileAbs(id);
    fs.mkdirSync(path.dirname(texPath), { recursive: true });
    fs.writeFileSync(texPath, content, 'utf8');
    const outDir = outputDir(id);
    fs.mkdirSync(outDir, { recursive: true });

    // cwd is the main file's own directory (not always the project root) so
    // that \input/\includegraphics paths inside imported projects — which
    // may nest their main file in a subfolder — resolve exactly as the
    // original project intended.
    const proc = spawn('tectonic', ['--outdir', outDir, texPath], {
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
  if (typeof content !== 'string') {
    return res.status(400).json({ success: false, log: 'Conteúdo inválido.' });
  }
  try {
    const result = await requestCompile(req.params.id, content);
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

// --- Real-time collaborative editing (Yjs via Hocuspocus) -------------------
// One Yjs document per project id, bridged to that project's main file on
// disk: this keeps the file as the single source of truth, so compiling,
// downloading, and reopening a project later all keep working exactly as
// before — whether or not anyone happens to be connected right now.
const COLLAB_PATH = '/collab';

const hocuspocus = new Hocuspocus({
  async onLoadDocument({ documentName, document }) {
    if (!isValidProjectId(documentName) || !fs.existsSync(projectDir(documentName))) return;
    if (document.isEmpty('content')) {
      const texPath = mainFileAbs(documentName);
      const content = fs.existsSync(texPath) ? fs.readFileSync(texPath, 'utf8') : '';
      document.getText('content').insert(0, content);
    }
  },
  async onStoreDocument({ documentName, document }) {
    if (!isValidProjectId(documentName) || !fs.existsSync(projectDir(documentName))) return;
    const texPath = mainFileAbs(documentName);
    fs.mkdirSync(path.dirname(texPath), { recursive: true });
    fs.writeFileSync(texPath, document.getText('content').toString(), 'utf8');
    touchProject(documentName);
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
