---
title: LaTeX Live
emoji: 📝
colorFrom: red
colorTo: gray
sdk: docker
app_port: 7860
---

# LaTeX Live

> O bloco acima é lido pelo Hugging Face Spaces quando este README vira a
> página de um Space (veja [Deploy](#deploy-github--hugging-face-spaces)
> mais abaixo); no GitHub ele só aparece como texto/YAML normal.

Editor de LaTeX local com preview ao vivo, no estilo Overleaf: uma tela
inicial lista seus projetos, e cada um abre num editor com `.tex` à esquerda
e o PDF recompilado e exibido à direita automaticamente.

## Requisitos

- Node.js (já disponível)
- [Tectonic](https://tectonic-typesetting.github.io/) — motor LaTeX standalone que
  baixa pacotes sob demanda (sem precisar instalar o TeX Live completo).
  Já está instalado neste ambiente via Homebrew (`brew install tectonic`).

## Como rodar

```bash
npm install
npm start
```

Depois abra http://localhost:4173 no navegador — isso mostra a tela de
projetos.

## Tela inicial (projetos)

- Lista todos os projetos, ordenados por "editado mais recentemente".
- **"+ Novo projeto"** pede um nome e abre um projeto em branco no editor.
- **"Importar .zip"** (botão ou arrastar o arquivo para a tela) sobe um zip
  — de um export do Overleaf, um template baixado, ou qualquer projeto LaTeX
  zipado — e cria um projeto novo a partir dele:
  - Se houver um `main.tex` na raiz do zip, ele é usado direto.
  - Senão, todo `.tex` do zip é escaneado por `\documentclass`; o candidato
    mais raso (e com nome parecido com "main"/"thesis"/"tese") é escolhido
    como arquivo principal — um aviso aparece dizendo qual foi escolhido.
  - Uma pasta "wrapper" única (comum em alguns exports, tipo
    `MeuProjeto/main.tex`) é removida automaticamente.
  - O arquivo principal pode ficar em qualquer subpasta: a compilação roda
    com o diretório dele como referência, então `\input`/`\includegraphics`
    relativos continuam funcionando como no projeto original.
- Cada card tem ✎ (renomear) e ✕ (excluir projeto, com confirmação).

## No editor

- Com "Autocompilar" ligado (padrão), a cada pausa na digitação (~700ms) o
  front-end envia o conteúdo para compilar. Com o toggle desligado, as
  edições só ficam marcadas como pendentes e a compilação só roda ao clicar
  em "Compilar agora" — a preferência fica salva no navegador.
- O compile roda `tectonic` e inclui uma passada automática de BibTeX quando
  o documento usa `\bibliography`.
- O preview à direita é renderizado com PDF.js diretamente em `<canvas>`
  (rolagem contínua, zoom e indicador de página — sem a barra nativa do
  navegador), e mostra o log de compilação em caso de erro.
- A barra lateral esquerda mostra os demais arquivos do projeto em árvore
  (imagens, `.bib`, outros `.tex`, subpastas, etc.). Dá para:
  - criar pastas com "+ Pasta" (aceita caminhos aninhados de uma vez, tipo
    `imagens/graficos`);
  - fazer upload arrastando arquivos para a barra (para a raiz) ou para uma
    pasta específica, ou usando "+ Upload" / o "+" de cada pasta;
  - renomear (✎) ou excluir (✕) qualquer arquivo ou pasta;
  - clicar num arquivo para inserir o comando LaTeX correspondente no cursor
    (`\includegraphics`, `\bibliography` ou `\input`), já com o caminho
    relativo completo quando ele estiver dentro de uma pasta.
- O nome do projeto (ao lado do logo, no topo) pode ser editado clicando
  nele — é usado como título da aba e como nome do arquivo ao clicar em
  "Baixar PDF". Clicar no logo volta para a tela de projetos.

## Estrutura

```
server.js                    servidor Express: projetos, upload/zip, tectonic, serve o PDF
projects/<id>/                um projeto — arquivo principal + demais arquivos
projects/<id>/.project.json   nome do projeto e qual arquivo é o principal
projects/<id>/.output/        PDF gerado (ignorado no git)
public/index.html             tela de projetos
public/editor.html            editor (CodeMirror + preview PDF.js + sidebar)
```

Cada projeto vive na sua própria pasta com um id gerado (uuid); o nome de
exibição fica em `.project.json`, não no nome da pasta.

## Performance com documentos e imagens pesadas

O projeto foi ajustado para aguentar documentos grandes (muitos capítulos,
figuras em alta resolução, bibliografias longas) sem travar:

- **Preview virtualizado**: o PDF.js só renderiza em `<canvas>` as páginas
  perto da área visível (com uma margem de rolagem); páginas que saem de
  vista são liberadas da memória. Um documento de centenas de páginas nunca
  mantém mais que um punhado de canvases carregados ao mesmo tempo — testado
  com um documento de 60 páginas mantendo só 3–5 renderizadas por vez.
- O PDF é carregado por URL (não como um `arrayBuffer` inteiro em memória),
  então o PDF.js usa HTTP range requests para começar a mostrar a primeira
  página antes de baixar o arquivo inteiro.
- A resolução de cada página é limitada a no máximo 2x (mesmo em telas com
  DPI maior), evitando canvases desnecessariamente grandes.
- Cada projeto tem sua própria fila de compilação — compilar um projeto
  nunca bloqueia ou interfere com outro.
- Limites (ajustáveis por variável de ambiente):
  - `MAX_UPLOAD_MB` (padrão 200) — tamanho máximo por arquivo enviado.
  - `MAX_ZIP_MB` (padrão 500) — tamanho máximo do .zip importado.
  - `COMPILE_TIMEOUT_MS` (padrão 180000 = 3 min) — documentos com muitas
    imagens ou muitas passadas de BibTeX podem demorar mais que o padrão de
    editores simples.
- A primeira compilação de cada projeto pode ser mais lenta (o `tectonic`
  baixa fontes/pacotes sob demanda); as seguintes usam o cache local dele e
  ficam bem mais rápidas.

```bash
MAX_UPLOAD_MB=500 MAX_ZIP_MB=1000 COMPILE_TIMEOUT_MS=300000 npm start
```

## Projeto de exemplo incluído

Na primeira execução, o antigo projeto único deste repositório é migrado
automaticamente para `projects/<id>/` e aparece na tela inicial. Ele mostra
os elementos comuns de um trabalho acadêmico usando múltiplos arquivos
`.tex` via `\input`: equação numerada (`\label`/`\eqref`), tabela
(`booktabs`), figura (`\includegraphics`) e bibliografia (`.bib`). Edite ou
substitua livremente — é só um ponto de partida.

## Deploy (GitHub + Hugging Face Spaces)

**GitHub Pages não serve para hospedar este app.** Pages só serve arquivos
estáticos — não roda o servidor Node, não executa o `tectonic`, não tem
disco para salvar projetos e não suporta WebSocket. Uma "tela de senha"
feita só em JavaScript de uma página estática também não protegeria nada de
verdade, porque o conteúdo do site já estaria público de qualquer forma.
GitHub continua ótimo para versionar o código (é só um repositório git) —
só a parte de _hospedar o app rodando_ que precisa de outro lugar.

Este repositório já vem pronto para rodar em qualquer lugar que aceite um
container Docker comum — inclusive **Hugging Face Spaces** (tem plano
gratuito, roda Docker de verdade, e é onde a senha compartilhada faz
sentido).

### Senha de acesso

Sem configurar nada, o site continua aberto (bom para uso local). Para
exigir senha, defina a variável de ambiente `SITE_PASSWORD`. Quem acessar
sem o cookie de sessão é redirecionado para uma tela de login simples; a
senha é comparada no servidor (não dá pra simplesmente ver o código-fonte e
descobrir ou pular a checagem, como aconteceria numa página estática).

```bash
SITE_PASSWORD=uma-senha-forte npm start
```

### Persistência dos projetos — leia antes de confiar dados importantes

Um container Docker comum (inclusive o disco padrão do Hugging Face
Spaces) **perde tudo que foi escrito em disco sempre que reinicia** —
qualquer projeto criado ou importado pelo site some. Duas opções:

1. **Aceitar que é efêmero** — bom para demonstrar o app ou sessões curtas,
   ruim para guardar uma dissertação de verdade.
2. **Apontar `PROJECTS_DIR` para um disco que persiste** — no Hugging Face
   Spaces isso é o add-on pago "Persistent Storage" (monta em `/data`):
   ```bash
   PROJECTS_DIR=/data/projects
   ```
   Em outros hosts (VPS, etc.), aponte para qualquer volume que sobrevive a
   reinícios.

### Publicando nos dois lugares

Um Space do Hugging Face é, na prática, só mais um repositório git — dá
para manter o GitHub como "fonte" e adicionar o Space como um segundo
remote:

```bash
git init
git add .
git commit -m "Versão inicial"

# GitHub (histórico/backup do código)
git remote add origin https://github.com/<seu-usuario>/<seu-repo>.git
git push -u origin main

# Hugging Face Space (onde o app roda de fato)
# Crie o Space antes em huggingface.co/new-space, SDK "Docker"
git remote add space https://huggingface.co/spaces/<seu-usuario>/<nome-do-space>
git push space main
```

Depois de criar o Space, em **Settings → Variables and secrets**, adicione
`SITE_PASSWORD` (como *secret*) e, se for usar o Persistent Storage,
`PROJECTS_DIR=/data/projects`. Cada `git push space main` reconstrói e
reinicia o container.

### Colaboração em tempo real (próximo passo)

Nada disso ainda existe — hoje cada projeto tem um único editor "por vez"
(a última versão salva vence). Para editar em tempo real com outras
pessoas via link, o caminho normal é uma biblioteca de CRDT (ex.: Yjs) +
um servidor de sincronização, plugada no CodeMirror. É viável sobre a base
atual, mas exige um host que mantenha WebSocket/processo vivo (Spaces com
Docker permite; GitHub Pages não) — fica para quando você quiser avançar
nisso.

## Limitações / próximos passos possíveis

- Só o arquivo principal do projeto é editável pela interface; outros
  arquivos `.tex` (capítulos, por exemplo) podem ser referenciados com
  `\input`, mas para editar o conteúdo deles hoje é preciso abrir o arquivo
  em `projects/<id>/` por fora. Dá para adicionar abas para editar múltiplos
  arquivos se for útil.
- Renomear só muda o nome dentro da mesma pasta (não dá para mover um
  arquivo para outra pasta arrastando — ainda).
- Detecção do arquivo principal num zip importado é uma heurística; em
  projetos com múltiplos `.tex` ambíguos pode escolher errado (o aviso na
  tela inicial avisa qual foi escolhido).
- Sem histórico de versões nem colaboração em tempo real.
