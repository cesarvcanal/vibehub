# Análise de PR pela tela — design

> Status: desenho aprovado em 16/11/2026; falta o plano de implementação. Nada implementado.

## Contexto

Pedido do César e do Albert (16/11/2026, por voz): parar o loop "abre um card no repo → digita
'analisa a PR 636' → abre outro card → repete". Querem uma feature no vibehub que liste as PRs
abertas, deixe escolher a PR e o revisor, e rode uma análise padrão com as skills já instaladas.

## O que já existe (conferido no código)

- **Fluxo de revisão orquestrada** (`back/src/services/review/`): o card do revisor nasce sem a
  conversa de quem escreveu (agnóstico), roda `/code-review high` com verificação que tenta derrubar
  cada achado, publica no GitHub e devolve achados estruturados (`vibehub_review_submit`).
- **Classificação com a autonomia pedida** (`prompts.ts`, `FINDING_CLASSES`): `blocking` (bug claro,
  a IA do autor corrige com prova), `improvement` (melhoria no que o PR mexe, aplicada sozinha),
  `question` (intenção/produto: pergunta a uma pessoa), `suggestion` (opcional, pessoa escolhe).
- **PR avulsa**: `vibehub_attach_prs` anexa PR aberta do mesmo repo a um card; ao revisar, o
  orquestrador cria sozinho o card de correção na branch da PR (`createFixCard`).
- **Revisor não escreve código**: o prompt proíbe commit e push no card do revisor.

## O que falta

1. **Porta de entrada pela tela.** PR avulsa só entra pela IA de um card; depois alguém ainda abre
   o "Pedir revisão". Não há lista de PRs abertas do repositório.
2. **Roteiro de análise mais completo.** Hoje a rodada 1 é só `/code-review high`. O pedido inclui:
   - qualidade da escrita contra o `AGENTS.md` do repo (nomes, código morto, voltas, fallback);
   - **testes e TDD**: mudança de comportamento tem teste? O teste testa de verdade ou só confirma a
     hipótese? Faltam bordas, falha, corrida, permissão?
   - colisão com funcionalidade existente (o PR quebra ou encavala algo que já funcionava);
   - melhorias, não só bugs: o objetivo é revisar e apontar, não reescrever o código.

## Decisão (16/11/2026, por voz): quem acha, corrige

O card da análise **corrige na hora** a falha clara que encontrar, sem mandar relatório para outro
dev corrigir depois. No resumo final ele diz o que achou e o que corrigiu. Dúvida, incoerência de
intenção ou mudança de produto continua sendo pergunta a uma pessoa, nunca correção.

Isso muda o desenho em relação ao fluxo de revisão atual (revisor só aponta, outra IA corrige):

- **Um card só** na branch da PR: analisa, corrige o `blocking` com teste primeiro (TDD: teste que
  reproduz a falha, vê falhar, corrige, vê passar), commita na branch da PR na conta de quem pediu
  a análise e publica o resumo na PR.
- `improvement` no código que o PR já mexe: aplica também, com o mesmo cuidado. `suggestion` e
  `question` só no resumo.
- A análise segue agnóstica: o card não recebe a conversa de quem escreveu, só a PR e o `AGENTS.md`.
- O fluxo de revisão com duas IAs continua existindo para quem quiser revisor humano separado; a
  análise é um modo novo ao lado dele, não substitui.

## Proposta

### Tela "PRs abertas" (front)

- Entrada no projeto (sidebar/board do projeto). Lista as PRs abertas do `repoFullName`: número,
  título, autor, branch → base, se já tem revisão em andamento.
- Ação "Analisar" abre o `RequestReviewDialog` existente (revisor, autor, coautor, quem mergeia),
  com a PR já escolhida.
- Estados: carregando, vazio, erro do GitHub, PR já em revisão (botão vira "Ver revisão").

### Back

- `GET /api/projects/:id/prs` (`requireSession` + filtro de acesso ao projeto): lista PRs abertas via
  `services/github/client.ts` com a conexão GitHub de quem pede (fallback: a do projeto, a mesma regra
  de identidade do resto). Sem fork, só PRs do próprio repo (mesma regra do `attachPrs`).
- `POST /api/projects/:id/prs/:number/analysis` (`requireSession` + `work` no projeto): cria o card
  "Análise PR #N" na branch da PR, anexa a PR (`attachPrs`) e envia o prompt da análise. Idempotente:
  PR com análise em andamento devolve o card existente, não abre outro.

### Roteiro da análise (prompt do card de análise)

Manter `/code-review high` como motor e somar, na mesma rodada, as skills instaladas que cobrem o
resto, todas sobre o diff cru:

1. `/code-review high`: bugs e regras do `AGENTS.md`.
2. `/security-review` quando o diff toca auth, shell, segredos ou rotas.
3. Checagem de testes/TDD explícita (lista acima) virando achados `blocking` (comportamento sem
   teste) ou `improvement`/`suggestion`.
4. `/simplify` sobre o código que o PR mexe: o que preserva comportamento entra como `improvement`.

A classificação e a autonomia continuam as de `FINDING_CLASSES`: nenhuma mudança de regra.

## Decisões fechadas (16/11/2026)

1. **Um card por PR** ("Análise PR #N"). Motivo do usuário: trabalham com vários cards em paralelo,
   e um card único acumulando PRs enche o contexto e a IA passa a errar.
2. **Skills somadas** ao `/code-review high`: `/security-review` (quando o diff toca auth, shell,
   segredos ou rotas) e `/simplify`, além da checagem de testes/TDD. Pedido do usuário: usar as
   skills instaladas, porque sem elas a análise deixa passar coisa.

3. **Seleção vem do GitHub, ao vivo.** Escolhe o repositório e as PRs abertas são buscadas no
   GitHub na hora (nada de lista guardada no vibehub). Os repositórios oferecidos são só os que já
   são projeto no vibehub (o card precisa de projeto para trabalhar); repo fora dele fica para depois. Ao nascer, o card faz `git fetch` e se põe na
   cabeça da PR antes de analisar; a cada nova rodada, de novo.
4. **Comentários na PR o tempo todo.** Cada achado vira comentário na linha do diff (`gh api` review
   com comentários por linha), cada correção responde no comentário do achado com o commit, e o
   resumo final vai como review da PR. Quem olha só o GitHub entende o que aconteceu.

## Testes previstos

- Rota de listagem: dono, `view`, sem acesso; GitHub falhando (erro visível, nunca lista vazia).
- Rota de análise: happy path, PR de fork recusada, PR já em revisão, revisor = autor, sem conexão.
- Prompt: teste de `prompts.test.ts` cobrindo as etapas novas.
- Front: lista com carregando/vazio/erro, clique em Analisar abre o diálogo com a PR, envio duplicado.
