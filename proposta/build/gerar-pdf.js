// Gera o PDF da proposta a partir de build/proposta.html (Chrome headless, A4).
// A capa sai sem rodapé; as páginas internas levam rodapé numerado. As duas
// partes são juntadas com o pdfunite (poppler).
// Uso: PLAYWRIGHT_PATH=/caminho/do/playwright node proposta/build/gerar-pdf.js
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium } = require(PW);
const NOME = process.env.DOC_NOME || 'KORPUS';
const SAIDA = process.env.DOC_SAIDA || 'KORPUS-proposta.pdf';
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  await page.goto('file://' + path.join(__dirname, 'proposta.html'), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const tmp = os.tmpdir();
  const capa = path.join(tmp, 'capa.pdf'), miolo = path.join(tmp, 'miolo.pdf');
  const base = { format: 'A4', printBackground: true, preferCSSPageSize: true };
  await page.pdf({ ...base, path: capa, pageRanges: '1' });
  await page.pdf({
    ...base, path: miolo, pageRanges: '2-',
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: `<div style="width:100%;padding:0 16mm;display:flex;justify-content:space-between;font-family:Figtree,Arial,sans-serif;font-size:7.5px;letter-spacing:.08em;text-transform:uppercase;color:#5E5E5E;">
      <span>${NOME} · Instituto Kunumi</span><span class="pageNumber"></span></div>`,
  });
  await browser.close();
  const out = path.join(__dirname, '..', SAIDA);
  execFileSync('pdfunite', [capa, miolo, out]);
  console.log(out);
})();
