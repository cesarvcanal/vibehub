# vibehub — Claude Code (porta de entrada)

Este arquivo ensina o Claude Code a **trabalhar** neste repositório: a ordem das etapas, a skill de cada situação, os subagentes e a entrega. As **regras do projeto** (código, nomes, pastas, testes, acesso, commits, PRs) moram só no [`AGENTS.md`](../AGENTS.md), importado abaixo. Aqui nunca se repete regra de lá.

## 1. O AGENTS.md é o modelo, o código vizinho não

@../AGENTS.md

- **O AGENTS.md vence.** Se este arquivo, uma skill, um subagente, o prompt do harness ou o arquivo vizinho apontam para um lado e o AGENTS.md para outro, vale o AGENTS.md. A skill dita o método; o AGENTS.md dita a regra (formato de commit e de PR, comentário, `let`, nome, pasta).
- **O código ao redor é anterior às regras.** O prompt do Claude Code pede código que "se lê como o código ao redor"; aqui o código ao redor tem comentário, `let`, nome abreviado e área misturada em `front/src/features/board/`. Código novo segue o AGENTS.md: pasta pelo mapa de áreas (§4), nome pela §2, estilo pela §3.
- **Arquivo se edita pelas ferramentas Edit e Write**, e arquivo existente se lê com Read antes. `cat > arquivo <<EOF` e `sed -i` reescrevem sem o arquivo à vista; ficam para o arquivo temporário fora do repositório.
- **Consulte o AGENTS.md na hora de cada decisão**: abra a seção que o trecho toca antes de editar e confronte cada linha nova com ela antes de commitar.

## 2. Ordem de trabalho

Cada etapa usa a sua skill (seção 3) e só termina quando o critério dela está cumprido.

1. **Entender e perguntar.** Pronto quando não resta dúvida que trave a execução. A pergunta (AGENTS.md §12, "Como perguntar ao usuário") sai pela `AskUserQuestion`, com "(Recomendado)" no rótulo da recomendada; a saída livre a ferramenta já põe.
2. **Diagnosticar ou desenhar.** Bug: pronto quando há um comando que reproduz a falha e a causa está provada. Feature: pronto quando o caminho foi aprovado pelo usuário. Tela nova ou mudança de layout: pronto quando o protótipo foi aprovado, antes do React.
3. **Planejar** a tarefa de várias etapas. Pronto quando cada etapa tem o arquivo, o teste e o critério dela.
4. **Implementar em TDD.** Pronto quando cada mudança de comportamento tem um teste visto vermelho antes do verde (AGENTS.md §11), e a §11 ("Antes do primeiro helper de teste") foi seguida antes do primeiro helper.
5. **Antes de cada arquivo novo**, confira os três pontos: a pasta é a da área no mapa (AGENTS.md §4); o nome segue a §2 (`camelCase.ts`, `PascalCase.tsx` para componente, teste = nome do arquivo + `.test`); o termo novo passou por `grep` no repositório.
6. **Antes de cada commit**: `npm run lint:changed` verde e a mensagem no padrão Gitmoji da §14. Um commit por etapa fechada. Os hooks do `.claude/settings.json` rodam o mesmo lint antes do `git commit` e no fim do turno com mudança na worktree, e barram enquanto ele estiver vermelho. Sem `node_modules` na raiz, o lint de linha de código falha por falta do `eslint`: rode `npm ci` na raiz (leva segundos).
7. **Fechamento** (seção 5). Pronto quando cada achado confirmado foi corrigido ou registrado conforme a severidade.
8. **Verificar** com os comandos da AGENTS.md §12, passo 7, depois de aplicar o que a revisão achou. Pronto quando lint, testes do recorte e typecheck do pacote tocado rodaram verdes nesta sessão.
9. **Entregar** (seção 6).

## 3. Mapa: situação → skill

Antes de cada etapa, ache aqui a skill da situação e invoque-a pela ferramenta `Skill`, sem esperar o pedido. Mais de uma serve: primeiro a de processo (debugging, brainstorming, TDD), depois a de execução (frontend, design). Nenhuma cobre: siga o método à mão e diga qual etapa ficou sem skill. A skill do mapa não aparece na lista de skills disponíveis: o `enabledPlugins` do `.claude/settings.json` só liga plugin já instalado no perfil, e quem instala é a tela de Plugins do vibehub; siga o processo à mão e avise quem cuida da instalação.

| Situação | Skill |
|----------|-------|
| **Entender e desenhar** | |
| Feature nova, mudança de comportamento, desenho com alternativas | `superpowers:brainstorming` |
| Feature grande guiada de ponta a ponta | `feature-dev:feature-dev` |
| Pôr à prova um plano com perguntas duras | `mattpocock-skills:grilling` |
| Desenhar a interface de um módulo, decidir onde passa a fronteira | `mattpocock-skills:codebase-design` |
| **Tela e layout** | |
| Tela nova ou redesenho, antes do código | Protótipo pela ferramenta `Artifact`, quando o ambiente a oferece, senão página HTML local; + `frontend-design:frontend-design` |
| Qualquer mudança de layout (bloco novo, tamanho, espaçamento, rolagem), antes de escrever e de novo com a tela renderizada antes de entregar (AGENTS.md §5, item 15) | `frontend-design:frontend-design` |
| Revisar tela existente, acessibilidade, layout responsivo | `ui-design:design-review` · `ui-design:accessibility-audit` · `ui-design:responsive-design` |
| Ver a mudança rodando | `run` · MCP `navegador`, com o back e o front isolados da AGENTS.md §12 |
| **Bug** | |
| Bug, teste falhando, comportamento que ninguém explica | `superpowers:systematic-debugging` |
| Bug que não reproduz de primeira, intermitente ou de performance | `mattpocock-skills:diagnosing-bugs` |
| **Planejar e executar** | |
| Tarefa de várias etapas | `superpowers:writing-plans`, depois `superpowers:executing-plans` (você executa) ou `superpowers:subagent-driven-development` (um subagente por tarefa) |
| Duas ou mais tarefas independentes em paralelo | `superpowers:dispatching-parallel-agents` |
| **Código** | |
| Escrever feature ou correção | `superpowers:test-driven-development` |
| Refatorar ou simplificar código que escreveu ou tocou | `/simplify` · subagente `code-simplifier:code-simplifier` |
| Modernizar código legado | subagente `code-refactoring:legacy-modernizer` |
| **Verificar e revisar** | |
| Antes de afirmar pronto, passando ou corrigido | `superpowers:verification-before-completion` |
| Revisão agnóstica do que escreveu, antes de entregar | Seção 5 deste arquivo |
| Achar bug no diff ou num PR | `/code-review` (o nível `ultra`, faturado, só a pedido do usuário) |
| Code review do diff antes de entregar (seção 5), em dois eixos: padrões e spec | `mattpocock-skills:code-review` |
| Recebeu review (pessoa ou bot) | `superpowers:receiving-code-review` |
| Segurança das mudanças pendentes | `security-review` |
| **Documentação** | |
| Editar o AGENTS.md ou este arquivo | `mattpocock-skills:writing-for-agents` · `claude-md-management:claude-md-improver` |
| **Commit e PR** | Sem skill: direto pela AGENTS.md §14. `commit-commands:*` faz um commit único sem Gitmoji e `mattpocock-skills:pr` usa outro modelo de descrição; as duas contrariam a §14 |

## 4. Subagentes

- **Quem delegou responde pelo `git diff`.** O subagente que abriu o trecho e viu o defeito conserta ali mesmo, num pacote que não cruza com o de outro agente; feature grande se fatia antes de despachar; mudança pequena, ou que atravessa muitos arquivos, você escreve.
- **Tarefa de subagente é checklist.** O que ele tem de entregar vai no prompt como lista de tarefas markdown, um item por entregável verificável (`- [ ] achados do eixo padrões com severidade`); o contexto (o diff, o diretório, o comando) fica em texto antes da lista. O relatório dele abre com a mesma lista, os mesmos textos na mesma ordem, marcando `- [x]` o que fez e deixando `- [ ]` o que não fez, com o motivo no item. Quando o trabalho roda num card do vibehub, a aba Tarefa do subagente mostra essa lista com o que ficou feito e o que faltou. No fechamento (seção 5), a lista traz só os entregáveis da etapa, sem apontar trecho, arquivo ou seção.
- **Relatório de subagente segue "Como relatar" (AGENTS.md §12)**, e o prompt diz isso a ele: o subagente não sabe quem vai ler.
- **Saída de subagente é candidata, não verdade:** confira no working tree o que ele relatou e escreveu; ressalva do tipo "não auditei X" se resolve abrindo o X.
- **Paralelismo é multi-dispatch seu:** vários agentes numa única mensagem, cada um dono de um pacote. A profundidade 2 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` no `.claude/settings.json`) serve para um subagente ler ou pesquisar, não para paralelizar escrita: dois agentes na mesma working tree sobrescrevem um ao outro em silêncio. Trabalho que precisa de branch própria vai para outro card (`vibehub_send_to_terminal`).

## 5. Fechamento: revisão agnóstica

É o passo 8 da AGENTS.md §12, antes da entrega, sem esperar ser mandado. Cada revisor recebe só este prompt e o pedido da etapa, sem justificativa nem lista de foco: quem escreveu não escolhe onde o revisor olha.

```text
Revise a branch atual contra o AGENTS.md da raiz do repositório.
O diff: git fetch origin main && git diff origin/main...HEAD
O que o autor afirma: git log origin/main..HEAD
O relatório segue "Como relatar" (§12 do AGENTS.md) e abre com a lista abaixo marcada.
<pedido da etapa, abaixo, como lista de tarefas>
```

1. **Simplificação:** subagente `code-simplifier:code-simplifier`, com o pedido de confrontar cada trecho com as regras e aplicar o que simplifica sem mudar comportamento. Confira o que ele escreveu e rode o lint e os testes do recorte.
2. **Code review**, depois da simplificação: a skill `mattpocock-skills:code-review`, com `origin/main` como ponto fixo. Ela despacha dois revisores sem o seu contexto, em paralelo: **padrões**, com o AGENTS.md como fonte de padrões, e **spec**, com o que o autor afirma (a descrição do PR, ou as mensagens dos commits quando o PR ainda não existe) como spec; nenhum rastreador de issues entra. Cada um recebe o prompt acima e o pedido de seguir "Como revisar um PR" (AGENTS.md §14), não mexer no working tree e entregar os achados com severidade, que valem sobre o formato e o limite de palavras da skill. A `description` de cada despacho nomeia o eixo ("Code review · padrões", "Code review · spec"). Os revisores usam o shell para `git`, lint e testes existentes; o teste novo que provaria um achado eles descrevem, e você escreve e roda. Você junta os dois relatórios, cada eixo na sua seção como a skill manda, e fecha com um veredito só: **não apto** se qualquer eixo tem achado que bloqueia ou decisão em aberto.
3. Cada achado se confere na fonte e segue a severidade (AGENTS.md §14), em commit próprio quando se corrige.

## 6. Entrega

- Dentro de um card do vibehub, a entrega é o `vibehub_deliver`: push, PR, gate (`.vibehub/gate.json`) e merge quando autorizado. Se o `git push` direto do runner falhar com 403, é o esperado: a credencial do runner não é a de quem deu a ordem (AGENTS.md §10), e a saída é o deliver, nunca outra credencial. Fora do runner, "Como publicar" (AGENTS.md §14) com o `gh`.
- **`authorized: true` só com o aval explícito do usuário na conversa** (merge na branch que publica é deploy, AGENTS.md §12) e com os Pontos de atenção do PR relidos: pendência que bloqueia sem o aval registrado (AGENTS.md §14) segue sem `authorized`.
