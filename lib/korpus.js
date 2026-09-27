// Prepara um projeto do LaTeX Live para a rede KORPUS: junta o arquivo
// principal com os \input/\include (recursivo) e extrai título, autores,
// resumo e palavras-chave do LaTeX. Funções puras, sem rede nem servidor.
const path = require('path');

const MAX_CHARS = 400_000; // acima disso o texto vai cortado (o resumo usa o início)

// Remove comentários (% até o fim da linha), respeitando \%.
function stripComments(tex) {
  return tex.split('\n').map((line) => line.replace(/(^|[^\\])%.*$/, '$1')).join('\n');
}

// Conteúdo entre as chaves que começam em `open` (índice do "{"), com aninhamento.
function braced(tex, open) {
  if (tex[open] !== '{') return null;
  let depth = 0;
  for (let i = open; i < tex.length; i++) {
    if (tex[i] === '\\') { i++; continue; }
    if (tex[i] === '{') depth++;
    else if (tex[i] === '}' && --depth === 0) return { text: tex.slice(open + 1, i), end: i + 1 };
  }
  return null;
}

// Argumento obrigatório de todas as ocorrências de \cmd[opcional]{...}.
function commandArgs(tex, cmd) {
  const out = [];
  const re = new RegExp(`\\\\${cmd}\\*?\\s*(\\[[^\\]]*\\]\\s*)?(?=\\{)`, 'g');
  let m;
  while ((m = re.exec(tex))) {
    const b = braced(tex, m.index + m[0].length);
    if (b) { out.push(b.text); re.lastIndex = b.end; }
  }
  return out;
}

function environment(tex, name) {
  const m = new RegExp(`\\\\begin\\{${name}\\}([\\s\\S]*?)\\\\end\\{${name}\\}`).exec(tex);
  return m ? m[1] : '';
}

// LaTeX → texto simples, o suficiente para metadados.
function plain(tex) {
  let s = String(tex || '');
  for (const cmd of ['thanks', 'footnote', 'inst', 'orcid', 'fnref', 'corref', 'ead', 'email', 'label', 'cite']) {
    s = s.replace(new RegExp(`\\\\${cmd}\\*?\\s*(\\[[^\\]]*\\])?\\{[^{}]*\\}`, 'g'), '');
  }
  return s
    .replace(/\\\\(\[[^\]]*\])?/g, ' ')
    .replace(/\\(textbf|textit|emph|textsc|texttt|mathrm|mathbf|text)\s*\{([^{}]*)\}/g, '$2')
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?/g, ' ')
    .replace(/[{}~$]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Junta o arquivo principal com os arquivos incluídos. `read(abs)` devolve o
// texto do arquivo (ou null). Caminhos relativos à pasta do arquivo principal,
// como na compilação.
function expandTex(mainAbs, read, root) {
  const base = path.dirname(mainAbs);
  const files = [];
  const seen = new Set();
  function load(abs, depth) {
    if (depth > 8 || seen.has(abs)) return '';
    if (root && !abs.startsWith(root)) return ''; // nunca sai do projeto
    seen.add(abs);
    const text = read(abs);
    if (text === null || text === undefined) return '';
    files.push(path.relative(base, abs) || path.basename(abs));
    return stripComments(text).replace(/\\(input|include|subfile)\s*\{([^}]+)\}/g, (all, _cmd, target) => {
      let rel = target.trim();
      if (!/\.[a-z]+$/i.test(rel)) rel += '.tex';
      return load(path.resolve(base, rel), depth + 1);
    });
  }
  const content = load(mainAbs, 0);
  return { content, files };
}

// Também entende os comandos do abnTeX2 (\titulo, \autor, resumo), usados em
// teses e dissertações brasileiras.
function extractMetadata(tex) {
  const title = plain(commandArgs(tex, 'title')[0] || commandArgs(tex, 'titulo')[0] || '');
  const authors = [];
  for (const block of [...commandArgs(tex, 'author'), ...commandArgs(tex, 'autor')]) {
    for (const part of block.split(/\\and\b|\\AND\b/)) {
      const name = plain(part.split(/\\\\/)[0]).replace(/\s*,\s*$/, '');
      if (name && name.length <= 120 && !authors.includes(name)) authors.push(name);
    }
  }
  const resumo = /\\begin\{resumo\}(\[[^\]]*\])?([\s\S]*?)\\end\{resumo\}/.exec(tex);
  const abstractTex = environment(tex, 'abstract') || (resumo ? resumo[2] : '');
  // "Palavras-chave: a, b" / "Keywords: a, b" escritas no texto do resumo.
  const kwLine = /(Palavras-chaves?|Keywords?)\s*\}?\s*[:.]\s*([^\n]+)/i.exec(abstractTex);
  const abstract = plain(abstractTex.replace(/(\\textbf\{)?(Palavras-chaves?|Keywords?)[\s\S]*$/i, '')).slice(0, 5000);
  const kwRaw = commandArgs(tex, 'keywords')[0] || environment(tex, 'keyword') || environment(tex, 'keywords') || (kwLine ? kwLine[2] : '');
  const keywords = plain(kwRaw.replace(/\\sep/g, ',')).split(/[,;·]/).map((k) => k.trim().replace(/\.$/, '')).filter((k) => k && k.length <= 80).slice(0, 20);
  const dc = /\\documentclass\s*(\[[^\]]*\])?\s*\{([^}]+)\}/.exec(tex);
  return { title, authors, abstract, keywords, documentClass: dc ? dc[2].trim() : '' };
}

// Pacote completo para enviar: conteúdo (cortado se muito grande) e metadados.
function buildPaper(mainAbs, read, root) {
  const { content, files } = expandTex(mainAbs, read, root);
  const truncated = content.length > MAX_CHARS;
  return {
    content: truncated ? content.slice(0, MAX_CHARS) : content,
    contentChars: content.length,
    truncated,
    files,
    metadata: extractMetadata(content),
  };
}

module.exports = { buildPaper, expandTex, extractMetadata, stripComments, plain, MAX_CHARS };
