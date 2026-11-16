# Análise de PR pela tela — Implementation Plan

> **For agentic workers:** use superpowers:executing-plans (ou subagent-driven-development) tarefa a
> tarefa. Cada tarefa é TDD: teste primeiro, ver falhar pelo motivo certo, implementar, ver passar.

**Spec:** `docs/superpowers/specs/2026-11-16-analise-de-pr-design.md`

**Goal:** no projeto, a pessoa abre "PRs abertas", vê as PRs buscadas no GitHub na hora, clica em
"Analisar" e nasce um card "Análise PR #N" na branch da PR que revisa com as skills instaladas,
corrige o que é claro (TDD, commit na conta de quem pediu), pergunta o que é de intenção e comenta
tudo na PR.

**Architecture:** reaproveita o que existe e soma pouco:
- leitura de PRs pelo `services/github/client.ts` (API REST, token da conexão), não por `gh` no runner;
- card criado com `createCard` (mesmo caminho do `createFixCard`), PR gravada com `recordCardPr`;
- prompt entregue com `sendToTerminal` (mesmas opções do `relayReview`: `wake`, `requireAgent`,
  `guardInteractiveMenu`, `viaNativeChat`, `beforeDeliver: recordCardActor`);
- entrega das correções pelo `vibehub_deliver` do próprio card (push na branch da PR, sem merge).

Nenhum orquestrador novo: a análise é um card comum com um prompt bem feito. O fluxo de revisão com
duas IAs (`startReview`) não muda.

## Global Constraints

- Card de análise **nunca mergeia**: o prompt proíbe `authorized: true`; merge segue humano.
- Só PR aberta, do mesmo repo do projeto, sem fork (mesma regra do `attachPrs`).
- Idempotente: PR com card de análise aberto devolve o card existente (por URL da PR, não por título).
- Identidade: leitura e commits na conexão/conta de quem pediu, regra atual de identidade por card.
- Texto de tela só por i18n (`en.ts` e `pt-BR.ts`).

## Tarefas

### 1. Listar PRs abertas no cliente GitHub (back)
- [ ] `listOpenPulls(connectionId, owner, repo)` em `services/github/client.ts`: `GET
      /repos/:o/:r/pulls?state=open&per_page=100`, devolve `{ number, title, author, branch, base,
      url, isFork, isDraft, updatedAt }`. Erro do GitHub sobe com status, sem token na mensagem.
- [ ] Teste em `client.test.ts` com `fetch` mockado (fronteira externa): mapeamento, fork marcado,
      401/404 viram erro visível (nunca lista vazia).

### 2. Rota `GET /api/projects/:id/prs` (back)
- [ ] `requireSession` + `canAccessProject`; projeto sem `repoFullName` = 400.
- [ ] Conexão: a do usuário quando tem, senão a do projeto (mesma regra do resto).
- [ ] Marca em cada PR o card de análise já aberto, se houver (`analysisCardId`).
- [ ] Testes pela rota real: dono, membro do projeto, sem acesso (403/404), GitHub falhando (502).

### 3. Prompt da análise (back, puro)
- [ ] `analysisPrompt({ prNumber, prUrl, branch, base })` em `services/review/prompts.ts`. Etapas:
  1. `git fetch origin && git reset --hard origin/<branch>`; ler o `AGENTS.md` do repo.
  2. `/code-review high` no PR; `/security-review` quando o diff toca auth, shell, segredos, rotas;
     checagem de testes/TDD (comportamento sem teste, teste que não testa, bordas faltando);
     `/simplify` sobre o que o PR mexe.
  3. Classificar com `FINDING_CLASSES` (mesmo texto da revisão, fonte única).
  4. Comentar cada achado na linha do diff (`gh api` review com comentários por linha).
  5. `blocking`/`improvement`: corrigir com teste primeiro, commit atômico, responder no
     comentário do achado com o sha. `question`: perguntar no chat do card e parar naquele item.
  6. Entregar pelo `vibehub_deliver` sem `authorized` (só push na branch da PR).
  7. Resumo final como review da PR: achado, corrigido (sha), em aberto.
- [ ] Teste em `prompts.test.ts`: etapas presentes, `FINDING_CLASSES` reaproveitado, nunca
      `authorized: true`.

### 4. Serviço `startAnalysis` (back)
- [ ] `services/review/analysis.ts`: `startAnalysis({ projectId, prNumber, requester })`:
      lê a PR (tarefa 1), recusa fork/fechada (`pr_fork`, `pr_fechada`), procura card aberto com a
      mesma `pr.url` → devolve; senão `createCard` na branch da PR (conta Claude de quem pediu),
      `recordCardPr`, `sendToTerminal` do prompt.
- [ ] Corrida: dois cliques simultâneos na mesma PR criam um card só (fila por PR, como o
      `serialStart` da revisão).
- [ ] Testes: happy path (card criado, PR gravada, prompt enviado ao host mockado), repetição
      devolve o mesmo card, corrida, fork recusado, quem pede sem conta Claude.

### 5. Rota `POST /api/projects/:id/prs/:number/analysis` (back)
- [ ] Autorização: ver ponto em aberto abaixo. Recusas do serviço viram 400, PR inexistente 404.
- [ ] Testes pela rota real com os níveis de acesso.

### 6. Front
- [ ] Tipos em `front/src/api/types.ts` (`OpenPr`, resposta da análise).
- [ ] `features/board/api.ts`: `listProjectPrs`, `startPrAnalysis`; hook `useProjectPrs` (React
      Query, refetch ao abrir, sem polling).
- [ ] Componente `ProjectPrsDialog` (primitivas de `components/ui`): lista, estados carregando /
      vazio / erro / já em análise ("Abrir card"), botão "Analisar" com envio duplicado bloqueado;
      ao criar, abre o card.
- [ ] Entrada no projeto (menu do projeto na `ProjectSidebar`).
- [ ] i18n nos dois idiomas. Testes com `renderApp`: lista, erro, clique envia o contrato certo,
      duplo clique não dispara duas vezes. Story no Storybook.

### 7. Fechamento
- [ ] `npm run test:changed`, `npx tsc --noEmit` (back), `npx tsc -b` (front).
- [ ] Revisão agnóstica (simplificação → code review) contra o `AGENTS.md`.
- [ ] `vibehub_deliver` com PR documentado (sem `authorized` até ordem de merge).

## Decisão: quem pode disparar a análise (16/11/2026)

Qualquer pessoa que trabalha no projeto: o dono da instalação **ou** quem tem share `work` no
projeto. Share só de `view` não dispara (leitura nunca autoriza mutação). Na tarefa 5, a rota checa
isso com um helper de nível por projeto em `auth/access.ts`, ao lado do `cardLevel`.

## Decisão: correções vão direto na branch da PR (16/11/2026)

O usuário escolheu commitar na própria branch da PR: quando a PR é aberta o autor já terminou, então
não há edição concorrente. Restrição técnica que sobra: o git não deixa duas worktrees na mesma
branch, e o card do autor costuma continuar com ela. Por isso o card de análise tem branch LOCAL
própria (`analysis/<slug>`, nascida de `origin/<branch da PR>`) e um campo opcional novo no card,
`pushBranch` (a branch da PR), que o `deliver` usa como destino do push
(`git push --force-with-lease origin HEAD:refs/heads/<pushBranch>`) e como `--head` na busca da PR.
Card sem o campo segue exatamente como hoje (leitura compatível do `board.json`).
