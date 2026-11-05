# Vários PRs por card — anexar PRs abertos e revisar cada um pelo vibehub

**Data:** 2026-11-05 · **Branch:** `card/feature-multiplos-reviews-9787`
**Mockup aprovado:** `/preview/8797/` (opção A: lista com rolagem; diálogo com o autor vindo do GitHub)
**Base:** a revisão de PR por IA (`2026-10-29-revisao-de-pr-design.md`). Nada dela muda.

## Problema

No card `review-pedido-abastecimento-albert` o César pediu "revisa os PRs #598 a #601". A IA revisou
ela mesma e publicou os pareceres no GitHub, porque nenhuma ferramenta dela cria uma revisão do
vibehub: a revisão só abre pelo botão "Pedir revisão", e esse botão só existe para o PR que o próprio
card entregou (um por base). Resultado: o vai-e-volta que a revisão do vibehub existe para matar
voltou — parecer no GitHub, alguém avisa o Albert, o Albert corrige, avisa de novo.

## Objetivo

Num card, pedir a análise de vários PRs abertos faz cada um virar uma linha de PR no card, já com o
autor lido do GitHub. A pessoa escolhe revisor e coautor em cada linha e inicia; cada PR roda o ciclo
de revisão que já existe (revisor ↔ autor, até 3 rodadas, merge humano), em paralelo, cada lado na
conta Claude de quem está no papel.

### Não-objetivos

- Mudar o ciclo de revisão (rodadas, prova, lista fechada, merge humano). Igual.
- Mudar o card que tem um PR que ele mesmo entregou. Igual, linha por linha.
- Iniciar revisão sozinho. Anexar só cria as linhas; quem inicia é uma pessoa, no diálogo.
- PR de fork (head em outro repositório): o card de correção não teria onde dar push. Recusado na anexação.

## Como funciona

### 1. Anexar PRs (`vibehub_attach_prs`)

Ferramenta MCP nova: `{ card, prs: [598, 599, "https://github.com/o/r/pull/600"] }` (até 20).
Para cada PR, o servidor roda `gh pr view` no worktree do card, com a conexão do card (a de sempre:
quem deu a ordem), e lê número, url, branch (head), base, login de quem abriu, título, estado e se é
de fork. PR aberto e do mesmo repositório entra em `card.prs` com `attached: true`, `author` e
`title`; o resto volta recusado com o motivo (`fechado`, `mergeado`, `fork`, `nao_encontrado`).
Idempotente pelo número: anexar de novo atualiza a linha, não duplica.

PR anexado não ocupa a vaga "um por base" do PR entregue: `recordCardPr` ignora os anexados ao
procurar a vaga, e anexar ignora um PR que o card já tem por entrega.

As instruções do maestro passam a dizer: pedido para revisar/analisar PRs abertos → anexe com
`vibehub_attach_prs` e diga que as linhas estão prontas para escolher revisor e coautor; **não revise
você mesmo nem publique review no GitHub**, salvo pedido explícito de "revisa você mesmo".

### 2. Iniciar a revisão de um PR anexado

O diálogo é o mesmo. O que muda no servidor (`startReview`), só para PR anexado:

1. **Card do autor (onde a correção roda).** Se um card vivo do mesmo projeto (não revisor, fora de
   `done`) já trabalha na branch do PR, é ele — inclusive o próprio card que anexou. Senão nasce um
   **card de correção**: título `Correção PR #N · <título do PR>`, branch = a branch do PR (o worktree
   nasce de `origin/<branch>`), base = a base do PR, **conta Claude do autor escolhido**, coluna
   `waiting`, visível no board, com o PR registrado nele. O autor ganha `work` nele, como o revisor
   no card do revisor.
2. A revisão grava `cardId` = card do autor (tudo que existe — relays, `vibehub_review_respond`,
   deliver, conferência do GitHub — segue igual) e `hubCardId` = o card que anexou, quando é outro.
3. Autor sem conta Claude própria, quando o card de correção precisa nascer: recusa `autor_sem_conta`.
4. Já existe revisão ativa daquele PR (pela url, em qualquer card): recusa `revisao_ativa`.
5. Falhou depois de criar o card de correção: o card sai junto, como o do revisor.

### 3. O card que anexou acompanha

- Os avisos de fase (pronto, impasse, mergeado) vão também ao card que anexou.
- Mergeado: o PR anexado ganha `mergedAt` lá também e a linha sai.
- O board manda em cada card `reviews`: a revisão mais recente (não cancelada) de cada PR, dele como
  autor ou como card que anexou. `review` (a mais recente) continua para a linha da barra lateral.
- `GET /api/cards/:id/review?pr=N` devolve a revisão daquele PR (como autor ou como card que anexou);
  sem `pr`, igual a hoje.

### 4. Tela (opção A do mockup)

- Uma linha por PR, igual à de hoje, com o login de quem abriu (anexados) e o estado da revisão.
- Com 2 ou mais PRs, um cabeçalho: "N PRs · x pronto · y em correção · …", que recolhe/expande a
  lista (lembrado por card neste aparelho). A lista tem altura máxima (~4 linhas) e rola por dentro;
  o chat continua visível. Com 1 PR, nada muda.
- Cada linha lê a revisão DELA ao vivo e abre o painel DELA (o painel recebe o número do PR).
- Diálogo de um PR anexado: diz "aberto por <login> no GitHub"; o autor vem preenchido com a pessoa
  cuja conexão GitHub própria tem aquele login (`/people` passa a trazer `githubLogin`); revisor e
  merge sugeridos como hoje. Quem não tem conta Claude própria aparece como "sem conta Claude" e não
  pode ser autor de um PR anexado.

## Decisões

- **Opção A** (card de correção por PR, em paralelo) — César, 05/11.
- **Conta Claude do autor escolhido** em cada card de correção — César, 05/11.
- **Lista com rolagem + cabeçalho recolhível** (mockup A) — César, 05/11.
- Reaproveitar o card que já está na branch do PR em vez de criar outro — minha: dois worktrees na
  mesma branch não coexistem no git, e o card do Albert já é o lugar natural da correção.
- PR de fork recusado na anexação — minha: o push iria ao repositório errado.
- Card de correção visível no board — minha: é um card de trabalho como outro qualquer; o autor pode
  abrir e conversar com ele.

## Testes

- registry: anexar idempotente; anexado não ocupa a vaga por base; PR entregue não vira anexado.
- deliver: parse do `gh pr view` (aberto, fechado, mergeado, fork, não encontrado).
- orquestrador: PR anexado cria card de correção na conta do autor e na branch do PR; reaproveita o
  card que já está na branch (inclusive o próprio); autor sem conta recusa; revisão ativa do mesmo PR
  em outro card recusa; falha limpa o card de correção; aviso e `mergedAt` chegam ao card que anexou;
  PR entregue segue o caminho de hoje.
- rotas: `?pr=N`; `reviews` por PR no board; `githubLogin` no `/people`.
- front: cabeçalho e recolher com 2+ PRs, nada com 1; linha mostra o autor; diálogo sugere o autor
  pelo login e trava quem não tem conta num anexado; cada linha abre o painel do seu PR.
