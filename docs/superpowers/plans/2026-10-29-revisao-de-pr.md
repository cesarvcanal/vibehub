# Revisão de PR orquestrada — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dev pede revisão do PR do card dele; a IA do revisor (conta Claude do revisor) e a IA do
autor (card do autor) trabalham sozinhas até `ready` ou `impasse`, publicando os reviews no GitHub;
o vibehub mostra o andamento e o merge é sempre um clique humano.

**Architecture:** Um módulo novo `back/src/services/review/` (modelo puro + store `reviews.json` +
orquestrador) liga peças que já existem: `deliver` (PR e merge), `sendToTerminal` (relay),
`onCardEvent` (turno terminou), `actAsParticipant`/`recordCardActor` (autoria). As IAs entregam
resultado ESTRUTURADO por duas ferramentas MCP novas, nunca por texto livre. O front ganha um bloco
de PR no chat, a janela de papéis, um painel à direita e a linha na barra lateral.

**Tech Stack:** Node + Fastify + TypeScript (back), React + TanStack Query + Tailwind (front),
Vitest nos dois, `zod` nas ferramentas MCP, `gh` no runner.

**Spec:** `docs/superpowers/specs/2026-10-29-revisao-de-pr-design.md` (mockup em
`docs/superpowers/specs/assets/2026-10-29-revisao-de-pr-mockup.html`).

## Global Constraints

- **IA NUNCA mergeia.** Nenhuma ferramenta MCP nova aceita merge; o merge só sai de
  `POST /api/reviews/:id/merge`, chamado por um humano que é o `mergerUserId`.
- Bloqueante só com prova: `proof.kind ∈ {failing_test, rule, scenario}` com `ref` não vazio. Sem
  prova → rebaixado a `suggestion` no servidor.
- Teto de rodadas: `MAX_ROUNDS = 3`.
- Revisor ≠ autor (recusado na rota).
- Merge: `gh pr merge --merge` (merge commit, nunca squash) e só se o head do PR == `reviewedSha`.
- Card do revisor: nunca faz push nem deliver; não aparece no board (`reviewOf` setado).
- Card do autor parado: o orquestrador o acorda, inclusive se estiver pausado (decisão do usuário,
  29/10). É o único caminho do vibehub que tira um card de Paused sem uma pessoa, e isso fica em log
  de auditoria `action: "review.wake"`.
- Antes de cada relay pro card do autor, o ator do card é o autor (`recordCardActor(autor, cardId)`);
  pro card do revisor, o revisor.
- Reviews no GitHub saem na conta do revisor, publicados pela IA do card do revisor via `gh pr review`.
- Textos de UI em pt-BR e en (`front/src/i18n/pt-BR.ts`, `en.ts`); sem emoji.
- Commits com a identidade do worktree, SEM `Co-Authored-By` e sem "Generated with".
- Testes por arquivo durante o trabalho (`npx vitest run <arquivo> -t "<caso>"`); antes de entregar,
  `npm run test:changed` + `npx tsc -b` em `back/` e `front/`. Nunca a suíte inteira.

## Review Focus

1. Push do autor DEPOIS do `ready` → o merge é recusado (`reason: "head_moved"`) e a revisão volta pra
   rodada seguinte (ou `impasse` se já está na 3). Teste na Task 4.
2. IA do revisor manda `blocking` sem prova, ou manda achado novo na rodada 2+ sem
   `introducedInRound` → rebaixado/recusado. Teste na Task 1.
3. A mesma IA chama `vibehub_review_submit` duas vezes na mesma rodada (retry) → a segunda é
   idempotente e não dispara um segundo relay. Teste na Task 3.
4. Card do autor pausado ou dormindo quando a lista chega → é acordado e recebe a lista. Teste na
   Task 3.
5. Member sem `work` tenta iniciar, ou alguém que não é o `mergerUserId` aperta merge → 403. Teste
   na Task 4.

---

### Task 1: Modelo puro da revisão

**Files:**
- Create: `back/src/services/review/model.ts`
- Test: `back/src/services/review/model.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MAX_ROUNDS = 3;
  export type ReviewPhase = "reviewing" | "fixing" | "ready" | "impasse" | "merged" | "cancelled";
  export type FindingSeverity = "blocking" | "suggestion" | "question" | "refuted";
  export type FindingStatus = "open" | "fixed" | "contested" | "accepted_risk" | "dropped";
  export interface FindingProof { kind: "failing_test" | "rule" | "scenario"; ref: string; detail?: string }
  export interface Finding {
    id: string; severity: FindingSeverity; title: string; file?: string; line?: number;
    proof?: FindingProof; fix?: string; status: FindingStatus; introducedInRound: number;
    commit?: string; authorReply?: string; reviewerReply?: string; humanDecision?: "keep" | "accept_risk" | "block" | "drop";
  }
  export interface ReviewEvent { at: number; round: number; who: "reviewer" | "author" | "system" | "human"; text: string }
  export interface Review {
    id: string; cardId: string; projectId: string; prNumber: number; prUrl: string; prBranch: string; base: string;
    reviewerUserId: string; authorUserId: string; coauthorUserId?: string; mergerUserId: string;
    reviewerCardId: string; round: number; phase: ReviewPhase; findings: Finding[]; log: ReviewEvent[];
    reviewedSha?: string; impasseReason?: string; lastSubmitRound?: number; lastRespondRound?: number;
    nudges: number; createdAt: number; updatedAt: number;
  }
  export type SubmittedFinding = Omit<Finding, "id" | "status" | "introducedInRound"> & { id?: string };
  export function normalizeSubmittedFindings(input: SubmittedFinding[], round: number, existing: Finding[]): Finding[];
  export function applyReviewerVerdicts(review: Review, updates: { id: string; status: FindingStatus; reviewerReply?: string }[]): Finding[];
  export function applyAuthorResponses(review: Review, items: { id: string; status: "fixed" | "contested"; commit?: string; reply: string }[]): Finding[];
  export function phaseAfterReviewerRound(review: Review): { phase: ReviewPhase; impasseReason?: string };
  export function blockingOpen(findings: Finding[]): Finding[];   // blocking com status open|contested
  export function pendingQuestions(findings: Finding[]): Finding[]; // question sem humanDecision
  ```

- [ ] **Step 1: Write the failing tests** em `model.test.ts`:
  - `"bloqueante sem prova vira sugestão"`: `normalizeSubmittedFindings([{severity:"blocking", title:"x"}], 1, [])[0].severity === "suggestion"`; com `proof:{kind:"rule", ref:""}` também vira sugestão; com `proof:{kind:"failing_test", ref:"a.test.ts:12"}` fica `blocking`, `status:"open"`, `introducedInRound:1`, `id` gerado (`f1`, `f2`… na ordem).
  - `"rodada 2+ só aceita achado novo marcado como criado pela correção"`: na rodada 2, item sem `id` existente e sem `introducedInRound: 2` explícito → lança `Error` com mensagem contendo `"lista fechada"`; com `introducedInRound: 2` e prova → aceito.
  - `"autor contesta sem resposta é recusado"`: `applyAuthorResponses` com `status:"contested", reply:""` lança.
  - `"ready só sem bloqueante aberto e sem dúvida pendente"`: `phaseAfterReviewerRound` devolve `ready` quando todos os `blocking` estão `fixed|accepted_risk|dropped` e nenhuma `question` está sem `humanDecision`; devolve `fixing` se há bloqueante aberto e `round < 3`; devolve `{phase:"impasse", impasseReason:"rodadas"}` com bloqueante aberto na rodada 3; com só `question` pendente devolve `reviewing` (espera humano, não gasta rodada).
  - `"sugestão nunca segura o ready"`: só sugestões `open` → `ready`.

- [ ] **Step 2:** `cd back && npx vitest run src/services/review/model.test.ts` → FAIL (módulo não existe).
- [ ] **Step 3:** Implementar `model.ts` (funções puras, sem I/O). Ids `f<n>` sequenciais sobre o total já existente.
- [ ] **Step 4:** Mesmo comando → PASS.
- [ ] **Step 5:** `git add back/src/services/review/model.* && git commit -m "feat(revisao-pr): modelo puro — prova obrigatória, lista fechada e teto de rodadas"`

---

### Task 2: Store `reviews.json` e `Card.prs` / `Card.reviewOf`

**Files:**
- Create: `back/src/services/review/store.ts`, `back/src/services/review/store.test.ts`
- Modify: `back/src/services/board/registry.ts` (interface `Card` ~272-471; `createCard` ~1511), `back/src/services/maestro/deliver.ts:274-` (grava PR)
- Test: `back/src/services/maestro/deliver.test.ts`

**Interfaces:**
- Consumes: `Review` (Task 1); `JsonStore` (`back/src/store/jsonStore.ts`); `dataPath`.
- Produces:
  ```ts
  // registry.ts
  export interface CardPr { number: number; url: string; base: string; branch: string; openedAt: number }
  // Card ganha: prs?: CardPr[]; reviewOf?: string;
  export async function recordCardPr(cardId: string, pr: Omit<CardPr, "openedAt">): Promise<void>; // upsert por base
  export async function createReviewerCard(input: { authorCard: Card; reviewerAccountSlug: string; prBranch: string; title: string }): Promise<Card>;
  // review/store.ts
  export async function getReview(id: string): Promise<Review | undefined>;
  export async function activeReviewFor(cardId: string, prNumber?: number): Promise<Review | undefined>; // phase ∉ {merged,cancelled}
  export async function reviewByReviewerCard(reviewerCardId: string): Promise<Review | undefined>;
  export async function listReviewsForCards(cardIds: string[]): Promise<Review[]>;
  export async function insertReview(r: Review): Promise<void>;
  export async function mutateReview(id: string, fn: (r: Review) => void): Promise<Review>; // atualiza updatedAt
  ```
- `createReviewerCard`: `base = prBranch`, `branch = "review/" + worktreeSlug`, `accountSlug = reviewerAccountSlug`, `reviewOf = authorCard.id`, mesmo `projectId`, `column:"waiting"`.
- `parsePushAndPr` já devolve `prUrl`; o número sai de `/pull/(\d+)`.

- [ ] **Step 1: Failing tests:**
  - `store.test.ts`: `"insere, muta e acha a revisão ativa do card"`; `"revisão merged ou cancelled não é ativa"`; `"duas mutações concorrentes não se perdem"` (`Promise.all` de duas `mutateReview` → as duas mudanças presentes).
  - `deliver.test.ts`: `"deliver grava o PR no card, um por base"` — dois delivers do mesmo card com `branch:"dev"` e depois `"prod"` → `card.prs` tem 2 itens; repetir `dev` atualiza, não duplica.
  - `registry.test.ts` (existente): `"card do revisor nasce da branch do PR, na conta do revisor, ligado ao autor"`.
- [ ] **Step 2:** Rodar os três arquivos filtrados pelos nomes → FAIL.
- [ ] **Step 3:** Implementar. Em `deliver()`, logo depois de `const prUrl = pr.prUrl;` chamar `recordCardPr`. Em `deliver()`, card com `reviewOf` → retorna `{ merged:false, reason:"locked", ... }` sem push (revisor nunca empurra). Hidratação do `board.json` tolera os campos ausentes.
- [ ] **Step 4:** Mesmos comandos → PASS.
- [ ] **Step 5:** Commit `feat(revisao-pr): store de revisões e PR gravado no card`.

---

### Task 3: Orquestrador e ferramentas MCP

**Files:**
- Create: `back/src/services/review/orchestrator.ts`, `back/src/services/review/prompts.ts`, `back/src/services/review/orchestrator.test.ts`
- Modify: `back/src/mcp/tools.ts` (registrar 2 ferramentas em `registerMaestroTools`), `back/src/index.ts` (chamar `startReviewOrchestrator()` no boot)

**Interfaces:**
- Consumes: Task 1, Task 2; `sendToTerminal(cardId, text, { wake:true, origin:{kind:"system", name:"revisão de PR"}, beforeDeliver, readyWaitMs: SEND_READY_WAIT_MS })` (`maestro.ts:461`); `onCardEvent` (`events/cardEvents.ts:128`); `recordCardActor` (`board/actor.ts:55`); `listUsers`; um helper de "tirar de Paused" — reutilizar a mesma função que a rota de mover card usa (`mcp/cardMove.ts` `moveCards`) para `waiting`.
- Produces:
  ```ts
  export async function startReview(input: { cardId: string; prNumber: number; reviewerUserId: string; authorUserId: string; coauthorUserId?: string; mergerUserId: string; by: string }): Promise<Review>;
  export async function submitReviewerRound(reviewerCardId: string, payload: { round: number; findings: SubmittedFinding[]; verdicts?: { id: string; status: FindingStatus; reviewerReply?: string }[]; headSha: string; summary: string }): Promise<Review>;
  export async function submitAuthorResponse(authorCardId: string, payload: { round: number; items: { id: string; status: "fixed" | "contested"; commit?: string; reply: string }[]; headSha: string }): Promise<Review>;
  export async function decideQuestion(reviewId: string, findingId: string, decision: "block" | "drop" | "keep" | "accept_risk", by: string): Promise<Review>;
  export function startReviewOrchestrator(): () => void; // assina onCardEvent; devolve unsubscribe
  // prompts.ts — textos fixos em pt-BR
  export function reviewerRoundPrompt(r: Review): string;   // rodada 1: rodar /code-review high no PR #N, regra de bloqueio, publicar `gh pr review --request-changes|--comment`, chamar vibehub_review_submit
  export function reviewerDeltaPrompt(r: Review): string;   // rodada 2+: git fetch + reset --hard origin/<prBranch>, conferir SÓ o diff desde reviewedSha anterior contra a lista, sem achado novo salvo introducedInRound
  export function authorFixPrompt(r: Review): string;       // lista fechada + receiving-code-review: bug no escopo → corrige com commit+teste; fora do escopo → não faz; contestar só com prova; push; responder cada achado no PR com `gh pr comment`; chamar vibehub_review_respond
  export function reviewerApprovePrompt(r: Review): string; // ready: `gh pr review --approve` com o resumo; NÃO mergear
  ```
- Ferramentas MCP (em `tools.ts`, mesmo padrão `ok`/`fail`): `vibehub_review_submit({ card, round, headSha, summary, findings[], verdicts[]? })` e `vibehub_review_respond({ card, round, headSha, items[] })`. `card` = `$VIBEHUB_CARD_ID`. Schemas `zod` espelham `SubmittedFinding`. Descrições dizem em inglês, como as vizinhas: "never merges; the merge is a human button".

Fluxo (o que os testes provam):
- `startReview`: cria a `Review` (`round:1, phase:"reviewing"`), cria o card do revisor, fixa o revisor como ator dele e manda `reviewerRoundPrompt`.
- `submitReviewerRound`: `round !== review.round` ou `lastSubmitRound === round` → devolve a revisão sem efeito (idempotente). Senão normaliza, aplica verdicts, grava `reviewedSha = headSha`, `lastSubmitRound`, calcula a fase:
  `fixing` → `recordCardActor(autor)` e manda `authorFixPrompt` ao card do autor (acordando se dormindo; se `pausedAt`, move pra `waiting` primeiro, log `review.wake`);
  `ready` → manda `reviewerApprovePrompt` ao card do revisor;
  `impasse` → nada é mandado; `log` registra o motivo.
- `submitAuthorResponse`: idempotente por `lastRespondRound`; aplica respostas, `round += 1`, `phase:"reviewing"`, manda `reviewerDeltaPrompt`.
- Toda mudança de fase pra `ready`, `impasse` ou `merged` grava um aviso (`recordMessage`, `messageType:"info"`) no card do autor, que chega ao autor, ao revisor e ao co-autor pela bandeja de avisos que já existe.
- `turn_finished` de um card de revisão ou do autor com revisão esperando a vez dele, sem o submit/respond daquela rodada: primeiro lembrete (`nudges += 1`, reenvia o prompt com "você terminou sem chamar a ferramenta"); segundo → `impasse`, `impasseReason:"IA não respondeu"`.

- [ ] **Step 1: Failing tests** (`orchestrator.test.ts`, mocks de `sendToTerminal`, `recordCardActor`, `createReviewerCard`, no estilo de `maestro.test.ts`):
  - `"iniciar cria o card do revisor e manda a rodada 1 pra ele"`
  - `"submit com bloqueante manda a lista ao autor, com o autor como ator"` — `recordCardActor` chamado com o autor ANTES de `sendToTerminal(cardDoAutor, …)`.
  - `"submit repetido na mesma rodada não manda de novo"` — `sendToTerminal` chamado 1 vez.
  - `"autor pausado é tirado de Paused e recebe a lista"`.
  - `"resposta do autor abre a rodada 2 só com o diff"` — prompt contém `reset --hard origin/<prBranch>` e o sha anterior.
  - `"rodada 3 com bloqueante vira impasse e não manda nada"`.
  - `"ready manda o revisor aprovar no GitHub e nunca chama merge"` — `deliver` mockado nunca chamado.
  - `"turno sem submit: lembra uma vez, depois impasse"`.
  - `"dúvida decidida pelo humano como block volta a ser bloqueante"`.
  - `"mudança pra ready grava aviso no card do autor"`.
- [ ] **Step 2:** `cd back && npx vitest run src/services/review/orchestrator.test.ts` → FAIL.
- [ ] **Step 3:** Implementar orquestrador, prompts e registrar as ferramentas. Listener do `onCardEvent` não lança e não bloqueia (enfileira com `void` + catch com `logger.warn`).
- [ ] **Step 4:** Mesmo comando → PASS; `npx vitest run src/mcp/server.test.ts` (lista de ferramentas) → PASS, atualizando o snapshot de nomes se existir.
- [ ] **Step 5:** Commit `feat(revisao-pr): orquestrador revisor↔autor e ferramentas MCP de submit/resposta`.

---

### Task 4: Rotas HTTP e merge preso ao commit revisado

**Files:**
- Create: `back/src/routes/reviews.ts`, `back/src/routes/reviews.test.ts`
- Modify: `back/src/index.ts` (registrar `reviewRoutes`), `back/src/routes/board.ts:129,136` (esconder `reviewOf` e anexar resumo), `back/src/services/maestro/deliver.ts` (modo só-merge)

**Interfaces:**
- Consumes: Tasks 1–3; `requireSession`, `requestUser`, `requireCardWork`/`cardLevel` (`auth/access.ts`); `sharesForTarget`; `creatorAccountSlug(userId)` (`auth/userGit.ts:138`).
- Produces:
  - `GET /api/cards/:id/people` (sessão + acesso ao card) → `{ people: { id, username, canReview: boolean }[] }`: owners + usuários com share no card ou no projeto; `canReview` = tem conta Claude resolvível.
  - `POST /api/cards/:id/review` body `{ prNumber, reviewerUserId, authorUserId, coauthorUserId?, mergerUserId }` (exige `work` no card) → `{ review }`. 400: `revisor_igual_autor`, `sem_pr`, `revisao_ativa`, `revisor_sem_conta`. 403 sem `work`.
  - `GET /api/cards/:id/review` → `{ review: Review | null }` (a ativa, ou a última).
  - `POST /api/reviews/:id/decide` body `{ findingId, decision }` → só `reviewerUserId` (ou owner); 403 senão.
  - `POST /api/reviews/:id/merge` → só `mergerUserId`; exige `phase:"ready"`; chama `deliver(cardId, { authorized:true, mergeOnly:true, expectedHeadSha: review.reviewedSha, by })` com o merger como ator (`recordCardActor(merger, cardId)` antes). Sucesso → `phase:"merged"`.
  - `deliver.ts`: `DeliverOpts` ganha `mergeOnly?: boolean; expectedHeadSha?: string`; `DeliverReason` ganha `"head_moved"`. `mergeOnly` pula o push (só resolve o PR com `gh pr view <branch> --json url,headRefOid`), compara `headRefOid` com `expectedHeadSha` → diferente devolve `head_moved` sem merge.
  - Board: `GET /api/cards` e `/api/projects/:id/cards` filtram `reviewOf` e anexam `review?: { id, prNumber, phase, round }` em cada card do autor (via `listReviewsForCards`).
  - `head_moved` na rota de merge → a revisão vai pra `reviewing` com `round+1` (ou `impasse` se `round === MAX_ROUNDS`) e o revisor recebe `reviewerDeltaPrompt`.

- [ ] **Step 1: Failing tests** (`reviews.test.ts`, no padrão de `routes/shares.test.ts` / `board.test.ts`):
  - `"revisor igual ao autor é recusado"`, `"card sem PR é recusado"`, `"segunda revisão ativa no mesmo PR é recusada"`, `"member sem work recebe 403"`.
  - `"people lista owner e quem tem share, com canReview"`.
  - `"só o responsável pelo merge mergeia"` (outro usuário → 403).
  - `"merge com head diferente do revisado é recusado e reabre a revisão"`.
  - `"merge só acontece em ready"` (fase `fixing` → 409).
  - `board.test.ts`: `"card do revisor não aparece na lista e o do autor traz o resumo da revisão"`.
  - `deliver.test.ts`: `"mergeOnly não dá push e recusa head_moved"` (script não contém `git push`).
- [ ] **Step 2:** Rodar os três arquivos filtrados → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Mesmos comandos → PASS; `cd back && npx tsc -b` sem erro.
- [ ] **Step 5:** Commit `feat(revisao-pr): rotas de papéis, revisão, decisão e merge preso ao commit revisado`.

---

### Task 5: Front — bloco do PR no chat e janela de papéis

**Files:**
- Modify: `front/src/api/types.ts:335` (`Card` ganha `prs?`, `review?`; tipos `Review`, `Finding`, `Person`)
- Create: `front/src/features/board/components/PrReviewBlock.tsx`, `RequestReviewDialog.tsx` + `.test.tsx` de cada
- Modify: `front/src/features/board/components/SdkChatView.tsx` (renderiza um `PrReviewBlock` por item de `card.prs`, depois da última mensagem do turno em que o PR nasceu — na prática: no fim da conversa, fixo acima do composer, como o `CardOutbox`), `front/src/i18n/pt-BR.ts`, `front/src/i18n/en.ts`

**Interfaces:**
- Consumes: rotas da Task 4 via `get`/`post` de `front/src/lib/api.ts`.
- Produces: `PrReviewBlock({ cardId, pr, review, onOpenPanel })`, `RequestReviewDialog({ cardId, pr, open, onClose })`; query keys `["card-people", cardId]`, `["card-review", cardId]`.
- Visual igual ao mockup tela 1: bloco com `PR #N`, `branch → base`, pill do estado (`sem revisão` / `rodada N/3` / `pronto pra merge` / `impasse`), botão "Pedir revisão" quando não há revisão; clicar no bloco com revisão chama `onOpenPanel`. Janela segue `ShareDialog.tsx`: 4 seletores (revisor, quem corrige, co-autor opcional, responsável pelo merge); revisor padrão = usuário logado se ele não for o autor; autor padrão = ator atual do card; erro inline `"O autor do PR não pode revisar o próprio PR."` e botão desabilitado; pessoa com `canReview:false` aparece desabilitada no seletor de revisor.

- [ ] **Step 1: Failing tests:** `"sem revisão mostra Pedir revisão"`, `"em revisão mostra rodada 2/3 e abre o painel ao clicar"`, `"escolher o autor como revisor mostra o erro e trava o botão"`, `"iniciar manda os 4 papéis pro POST"`.
- [ ] **Step 2:** `cd front && npx vitest run src/features/board/components/PrReviewBlock.test.tsx src/features/board/components/RequestReviewDialog.test.tsx` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Mesmo comando → PASS.
- [ ] **Step 5:** Commit `feat(revisao-pr): bloco do PR no chat e janela de papéis`.

---

### Task 6: Front — painel de acompanhamento e linha na barra lateral

**Files:**
- Create: `front/src/features/board/components/ReviewPanel.tsx` + `ReviewPanel.test.tsx`
- Modify: `front/src/features/board/components/CardTerminalView.tsx` (pane à direita no `card-workarea`, ao lado de onde entra o `VncPanel` ~1255; estado `reviewOpen`; `PrReviewBlock.onOpenPanel` abre), `front/src/features/board/components/ProjectSidebar.tsx` (~965-1000: linha "↳ PR #N · estado" embaixo do card quando `card.review` existe; clique abre o card com o painel aberto via query `?review=1`), i18n

**Interfaces:**
- Consumes: `["card-review", cardId]` (Task 5), `POST /api/reviews/:id/decide`, `POST /api/reviews/:id/merge`, `useMe`/usuário logado (já existe no front).
- Produces: `ReviewPanel({ cardId, onClose })` com `refetchInterval: 3_000` enquanto `phase ∈ {reviewing, fixing}`.
- Conteúdo (mockup tela 3): cabeçalho `PR #N → base` + pill `rodada N de 3` + barra de 3 segmentos; papéis; "Lista fechada" (severidade, título, prova `kind`+`ref`, status, commit; `refuted` riscado); dúvidas pendentes com botões "Bloquear"/"Descartar" (só pro revisor); no `impasse`, por item travado, "Manter bloqueio"/"Aceitar risco" (só pro revisor); "Conversa das IAs" = últimas 5 entradas do `log` com "ver inteira"; veredito com "Mergear na <base>" visível só pro `mergerUserId` e só em `ready`, + "Abrir no GitHub" (`prUrl`). Cores da linha da barra lateral: `ready` verde, `reviewing|fixing` laranja, `impasse` azul.

- [ ] **Step 1: Failing tests:** `"merge só aparece pro responsável e só em ready"`, `"achado derrubado aparece riscado"`, `"dúvida pendente mostra os botões só pro revisor"`, `"impasse mostra decisão por item travado"`, `ProjectSidebar.test.ts`: `"card com revisão mostra a linha do PR com o estado"`.
- [ ] **Step 2:** Rodar os arquivos filtrados → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** PASS; `cd front && npx tsc -b` sem erro.
- [ ] **Step 5:** Commit `feat(revisao-pr): painel de acompanhamento e linha do PR na barra lateral`.

---

### Task 7: Verificação final e entrega

- [ ] **Step 1:** `npm run test:changed` na raiz → verde (falhas conhecidas de `changes.test.ts` e `resume.deployAgentTurn.test.ts` no runner são pré-existentes; confirmar contra a `main` se aparecerem).
- [ ] **Step 2:** `cd back && npx tsc -b` e `cd front && npx tsc -b` → sem erro.
- [ ] **Step 3:** Teste pela tela (CLAUDE.local.md): back isolado em porta livre com `VIBEHUB_DATA_DIR=/tmp/vh-rev`, front apontando pra ele, card semeado com `prs` e uma `Review` em cada fase no `reviews.json`; conferir bloco, janela, painel e linha lateral no navegador (1440x900).
- [ ] **Step 4:** `vibehub_deliver` pra `main` (sem `authorized` — o merge é do usuário). PR com descrição completa: contexto, decisões, testes rodados e recomendados.
