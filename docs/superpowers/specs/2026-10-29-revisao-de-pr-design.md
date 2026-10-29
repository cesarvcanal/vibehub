# Revisão de PR por IA — revisor e autor trabalhando até fechar

**Data:** 2026-10-29 · **Branch:** `card/feat-analise-prs-duas-ias-e914`
**Mockup aprovado:** `/preview/8791/` (telas 1 e 2; tela 3 = o painel que abre ao clicar no PR)

## Problema

Quando um dev (ex.: Albert) abre PR, o revisor (ex.: Mussa) hoje:

1. cria um card só pra revisar e manda a IA dele revisar;
2. copia o parecer e manda pro dev;
3. o dev cola no card dele, a IA dele corrige, o dev avisa;
4. volta pro passo 1.

No caso real dos PRs #551–#554 do erp-aux (cards `suporte-pr-albert-o-que-melhorar` e
`review-prs-albert`) isso deu ~10 voltas. Duas causas, nessa ordem de peso:

- **O review nunca acaba.** IA mandada "achar problema" sempre acha algo; cada rodada amostra outro
  canto; bug real, gosto e "poderia ser melhor" chegam com o mesmo peso. O revisor não consegue
  distinguir achado de delírio.
- **O humano é carteiro** entre duas IAs, e cada volta espera os dois estarem olhando.

## Objetivo

O dev pede revisão do PR; a IA do revisor (na conta Claude do revisor) e a IA do autor (no card do
autor, na conta dele) trabalham sozinhas até fechar, com regra que impede loop e delírio. Os humanos
acompanham e decidem o merge. **IA nunca mergeia.**

### Critérios de sucesso

- Caminho feliz com duas ações humanas: "Pedir revisão" (escolher papéis) e "Mergear".
- Toda revisão termina em no máximo 3 rodadas, com veredito `pronto` ou `impasse`.
- Todo achado bloqueante mostra a prova; o humano consegue checar se a IA inventou sem ler raciocínio.
- Ninguém copia e cola texto entre cards.

### Fora de escopo (v1)

- PR aberto fora do vibehub (direto no GitHub). Só PR que nasce de um card.
- Mais de um revisor no mesmo PR.
- Merge automático, mesmo com veredito verde.
- Duas IAs "debatendo" em chat livre. A conversa existe, mas o que conta é a lista de achados.

## Decisões tomadas no briefing

| Decisão | Escolha |
|---|---|
| O que bloqueia o merge | **Só achado com prova:** (a) bug com teste que falha na branch do PR ou cenário concreto com arquivo:linha — inclui risco de quebrar funcionalidade existente; (b) quebra de regra **escrita** do repo, citada; (c) segurança/permissão. O resto é **sugestão**: aparece, nunca bloqueia, nunca abre rodada. |
| Ferramenta do revisor | Sempre o `/code-review` (nível alto, com a etapa de verificação que tenta derrubar cada achado). |
| Revisor ≠ autor | O vibehub recusa. |
| Papéis escolhíveis | Revisor, quem corrige (autor), co-autor (opcional), responsável pelo merge. |
| Onde aparece | (1) bloco do PR no chat do card do dev, com "Pedir revisão" → janela de papéis; clicar no bloco abre o acompanhamento; (2) linha "↳ PR #N · estado" embaixo do card na barra lateral. |
| Merge | **NUNCA pela IA, de forma alguma, sem autorização humana.** Botão humano, só pro responsável pelo merge. |
| Autonomia (29/10) | Tudo que não é merge a IA faz sozinha. **Bug dentro do escopo do PR** (inclusive bug criado sem querer pela correção) → corrige sozinha. **Feature ou mudança fora do escopo** → só sugere, não faz. **Risco que pode comprometer e ela não tem certeza** → pergunta ao revisor humano e segue com o resto enquanto espera. |
| Onde a revisão mora (29/10) | **No GitHub.** O PR, os comentários e a aprovação ficam no GitHub, como sempre. O vibehub orquestra (ninguém joga bola de card pra card), deixa claro o que está acontecendo e já sabe quem é revisor, autor e co-autor. |

### Por que não "duas IAs conversando até concordar"

É o mesmo modelo dos dois lados; a diferença entre elas é de contexto (o autor sabe a intenção, o
revisor tem olho fresco), e essa troca tem valor. Mas consenso entre duas IAs é prova fraca: a autora
tende a aceitar todo apontamento, a revisora tende a aceitar justificativa bem escrita. Por isso a
conversa é guiada por **prova**, não por acordo, e a lista é **fechada** depois da rodada 1.

## Desenho

### A. Modelo: `Card.pr` e `Review`

- `Card.pr?: { number, url, base, openedAt }` — gravado pelo `deliver()` quando abre ou reusa o PR
  (`services/maestro/deliver.ts:274`; hoje o `prUrl` é devolvido e descartado).
- `Review` (nova coleção no `board.json`, mesma `JsonStore`):
  ```
  { id, cardId (do autor), prNumber, base,
    reviewerUserId, authorUserId, coauthorUserId?, mergerUserId,
    reviewerCardId,               // sessão do revisor (ver C)
    round: 1..3, phase: 'reviewing' | 'fixing' | 'ready' | 'impasse' | 'merged' | 'cancelled',
    findings: Finding[], log: ReviewEvent[], createdAt, updatedAt }
  Finding = { id, severity: 'blocking' | 'suggestion' | 'question' | 'refuted',
              // question = risco sem certeza: vira pergunta pro revisor humano
              title, file?, line?, proof: { kind: 'failing_test' | 'rule' | 'scenario', ref, detail },
              fix?: string,       // correção proposta
              status: 'open' | 'fixed' | 'contested' | 'accepted_risk' | 'dropped',
              commit?, authorReply?, reviewerReply? }
  ```
- Validação no servidor: `severity:'blocking'` sem `proof` é rebaixado a `suggestion`. É a regra do
  briefing aplicada em código, não em prompt.

### B. Papéis e quem pode iniciar

- Rota nova `GET /api/cards/:id/people`: owner(s) + usuários com share no card ou no projeto. Hoje
  `GET /api/users` é só do owner (`routes/users.ts:92`), e member precisa ver a lista pra escolher.
- `POST /api/cards/:id/review` com os papéis. Recusa: revisor == autor; card sem `pr`; revisão já
  ativa no mesmo PR; revisor sem conta Claude resolvível (`creatorAccountSlug`, `userGit.ts:138`).
- Pode iniciar: quem tem nível `work` no card do autor (o próprio dev ou o owner).

### C. A sessão do revisor

Uma sessão só roda numa conta Claude (`effectiveAccountSlug`, `registry.ts:844`), então o revisor
precisa de um card próprio:

- Card criado pelo servidor com `accountSlug` = conta Claude do revisor, `base` = branch do PR,
  `reviewOf: <cardId do autor>` e ator = revisor. Ele faz checkout da branch pra rodar testes.
- **Não aparece como card na barra lateral nem no kanban**: é representado só pela linha "↳ PR". O
  painel de acompanhamento tem "abrir sessão do revisor" pra quem quiser ver o terminal.
- Nunca commita no código do autor e nunca dá push: é revisor. `deliver` nesse card é recusado.

### D. O ciclo (servidor orquestra; humano não é carteiro)

1. **Rodada 1:** o servidor manda pro card do revisor o prompt de revisão: rodar `/code-review` no PR,
   aplicar a regra de bloqueio, e entregar o resultado chamando a ferramenta MCP nova
   **`vibehub_review_submit({ findings, summary })`**. Resultado sai estruturado, não em texto livre.
2. Ao receber o submit, o servidor grava os achados, muda a fase para `fixing` e manda pro card do
   autor a lista fechada (via `sendToTerminal`, `maestro.ts:461`), com a instrução de seguir o
   `receiving-code-review`: conferir cada item, corrigir com commit e teste, ou contestar **com prova**.
   O autor responde com **`vibehub_review_respond({ items: [{ id, status, commit?, reply }] })`**, depois
   de fazer push na branch do PR.
3. **Rodada 2..3:** o revisor recebe só o diff novo desde a rodada anterior e as respostas. Pode
   fechar, manter aberto (com o porquê) ou aceitar a contestação. Achado novo só entra se for bug
   criado pela própria correção (marcado `introducedInRound`). A cada rodada o revisor publica o
   review no PR do GitHub, na conta dele.
4. **Dúvida:** achado `question` (risco que pode comprometer, sem certeza) vira uma decisão pendente
   pro revisor humano no painel (e na bandeja de decisões do vibehub). A resposta transforma o item
   em `blocking` ou `dropped`; o ciclo segue com os outros itens enquanto isso, e o `ready` espera
   todas as dúvidas respondidas.
5. **Fim:** sem bloqueante aberto nem dúvida pendente → `ready`, e o revisor posta Approve no GitHub. Bateu 3 rodadas com bloqueante aberto ou contestado →
   `impasse`, mostrando só os itens travados com o argumento de cada lado.
6. **Fallback de turno sem submit:** o gancho `onCardEvent` / `turn_finished`
   (`services/events/cardEvents.ts:128`) detecta que o card terminou o turno sem chamar a ferramenta;
   o servidor lembra uma vez; na segunda, a fase vira `impasse` com motivo "IA não respondeu".
7. **Mensagem humana no meio:** se alguém escreve no card do autor ou do revisor, o ciclo espera o
   turno acabar (já existe `respectHumanActive` / outbox) e segue.

### E. Front

- **Bloco do PR no chat** (`SdkChatView`): renderizado a partir de `card.pr` + `review`, não do texto
  da ferramenta. Estados: sem revisão → botão "Pedir revisão"; em revisão → "rodada N/3"; pronto;
  impasse. Clicar abre o painel de acompanhamento.
- **Janela de papéis**: segue o padrão do `ShareDialog.tsx`. 4 seletores; erro inline se revisor =
  autor.
- **Painel de acompanhamento** (coluna direita do `card-workarea`, como o `VncPanel`): papéis,
  barra de rodadas, lista fechada (prova + status + commit), conversa resumida (o `log`) e veredito
  com "Mergear na <base>" (só pro responsável), "Ver diff", "Abrir no GitHub".
- **Barra lateral** (`ProjectSidebar.tsx`): linha "↳ PR #N · estado" embaixo do card, colorida por
  fase; clique abre o card com o painel aberto.

### F. Merge

O botão chama `deliver({ authorized: true })` no card do autor, com o **responsável pelo merge** como
ator (o clique é a autorização). Gate vermelho continua barrando. Merge commit, nunca squash
(`gh pr merge --merge`, já é assim em `deliver.ts:144`).

## Testes

- Modelo: `blocking` sem prova vira `suggestion`; transições de fase; teto de 3 rodadas; achado novo
  na rodada 2+ sem `introducedInRound` é recusado.
- Rota: revisor == autor recusado; card sem PR; revisão duplicada; member sem `work` recusado.
- Orquestração: submit → relay pro autor; respond → relay pro revisor; turno sem submit → lembrete →
  impasse; card pausado; mensagem humana no meio.
- Front: bloco do PR em cada estado; janela de papéis com erro; linha da barra lateral; merge só
  aparece pro responsável.

## Entrega

PR pra `main` do `cesarvcanal/vibehub` via `vibehub_deliver`, commits atômicos por camada (modelo →
rotas → orquestração → MCP → front).

## Decisões do builder (chamadas minhas, marcadas para conferência)

- **Merge preso ao commit revisado.** `Review.reviewedSha` = head do PR quando o revisor fechou.
  O botão de merge só funciona se o head ainda for esse; qualquer push depois do `ready` volta a
  revisão para uma rodada nova (se sobrar rodada) ou `impasse`. `deliver` ganha modo "só mergear"
  (sem push) para o botão — senão o push do merge carregaria commit não revisado.
- **Branch no card do revisor:** worktree destacado em `origin/<branch do PR>` (o branch já está
  checado no worktree do autor e `git worktree add` recusaria). A cada rodada, `git fetch` +
  checkout do head novo. `base` do card do revisor continua sendo a base do PR, não o branch.
- **Vários PRs por card:** `Card.prs[]` chaveado por `base` (dev, depois prod geram PRs diferentes).
  O bloco no chat e a linha da barra lateral mostram o PR ativo mais recente; cada bloco no chat
  pede revisão do próprio PR.
- **Autoria no relay:** antes de mandar a lista ao card do autor, o servidor fixa o ator do card no
  autor (`actAsParticipant`), para commit e push saírem na conta dele, não na do revisor nem do
  servidor. Merge sai com o token do responsável pelo merge; 403 para e avisa — nunca cai para a
  conexão do projeto.
- **Card do revisor:** visível e digitável só pelo revisor e pelo owner; o autor vê em leitura.
- **Mockup:** cópia estática em `docs/superpowers/specs/assets/2026-10-29-revisao-de-pr-mockup.html`.

## Em aberto (decisão do usuário)

- **Impasse (decidido 29/10):** o revisor humano decide cada item travado: manter bloqueio (o dev
  resolve na mão) ou aceitar como risco. Liberado o último, o merge aparece.
- **Co-autor (decidido 29/10):** só acompanha — vê o painel e recebe aviso de estado; não corrige.
- **Card do autor parado (decidido 29/10):** o vibehub retoma o card sozinho e a IA do autor segue.
  "Pedir revisão" vale como autorização de gastar a conta Claude do autor nesse ciclo.
- **Parecer no GitHub (decidido 29/10):** sim. Cada rodada do revisor vira um review no PR, na conta
  do revisor (Request changes com os achados; comentário com as sugestões). Quando fecha `ready`, a
  IA do revisor posta **Approve**. O autor responde cada achado no GitHub também. Aprovar não é
  mergear: o merge continua sendo só o botão humano.
