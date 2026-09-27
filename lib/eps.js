// Figuras EPS: o tectonic não lê PostScript ("PostScript images are not
// supported by Tectonic"). Como o Overleaf, convertemos cada .eps para PDF com
// o Ghostscript antes de compilar.
//
// Os arquivos do usuário não são alterados: a compilação roda numa cópia de
// trabalho (.output/build/) que espelha o projeto — links para os arquivos
// originais, os .tex copiados com \includegraphics{x.eps} → {x.pdf} e os PDFs
// convertidos. Sem nenhum .eps no projeto, nada disso acontece.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SKIP = new Set(['.output', '.yjs', '.git', '__MACOSX', 'node_modules']);

function walk(root) {
  const out = [];
  (function go(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) go(abs);
      else if (e.isFile()) out.push(abs);
    }
  })(root);
  return out;
}

let gsCache;
// Ghostscript disponível? (gs no PATH; GHOSTSCRIPT=/caminho força outro)
function findGhostscript() {
  if (gsCache !== undefined) return gsCache;
  const candidates = [process.env.GHOSTSCRIPT, 'gs'].filter(Boolean);
  gsCache = new Promise((resolve) => {
    const next = (i) => {
      if (i >= candidates.length) return resolve(null);
      execFile(candidates[i], ['--version'], { timeout: 5000 }, (err) => (err ? next(i + 1) : resolve(candidates[i])));
    };
    next(0);
  });
  return gsCache;
}

function convert(gs, epsAbs, pdfAbs) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(pdfAbs), { recursive: true });
    // -dSAFER: o PostScript não acessa arquivos nem roda comandos; -dEPSCrop: corta na BoundingBox.
    execFile(gs, ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-dEPSCrop', '-sDEVICE=pdfwrite', `-sOutputFile=${pdfAbs}`, epsAbs],
      { timeout: 60000 }, (err, _out, stderr) => (err ? reject(new Error(`falha ao converter ${path.basename(epsAbs)}: ${stderr || err.message}`)) : resolve()));
  });
}

// \includegraphics[...]{fig.eps} → {fig.pdf} (só na cópia de trabalho).
function rewriteTex(text) {
  return text.replace(/(\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)?\{)([^{}]+?)\.eps(\s*\})/gi, '$1$2.pdf$3');
}

// Prepara a compilação. Devolve null (compilar o projeto como está) ou
// { mainAbs, notes } com o arquivo principal dentro da cópia de trabalho.
async function prepare({ projectRoot, mainAbs, outDir }) {
  const files = walk(projectRoot);
  const eps = files.filter((f) => /\.eps$/i.test(f));
  if (!eps.length) return null;
  const gs = await findGhostscript();
  if (!gs) return { missingGhostscript: true, count: eps.length };

  const cacheDir = path.join(outDir, 'eps-cache');
  const buildDir = path.join(outDir, 'build');
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  const notes = [];

  for (const abs of files) {
    const rel = path.relative(projectRoot, abs);
    const dest = path.join(buildDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (/\.tex$/i.test(rel)) {
      fs.writeFileSync(dest, rewriteTex(fs.readFileSync(abs, 'utf8')));
    } else {
      fs.symlinkSync(abs, dest);
    }
  }

  for (const abs of eps) {
    const rel = path.relative(projectRoot, abs);
    const pdfRel = rel.replace(/\.eps$/i, '.pdf');
    if (fs.existsSync(path.join(projectRoot, pdfRel))) continue; // o projeto já tem o PDF: usa o dele
    const cached = path.join(cacheDir, pdfRel);
    const fresh = fs.existsSync(cached) && fs.statSync(cached).mtimeMs >= fs.statSync(abs).mtimeMs;
    if (!fresh) { await convert(gs, abs, cached); notes.push(`convertido para PDF: ${rel}`); }
    fs.symlinkSync(cached, path.join(buildDir, pdfRel));
  }

  return { mainAbs: path.join(buildDir, path.relative(projectRoot, mainAbs)), notes };
}

module.exports = { prepare, rewriteTex, findGhostscript };
