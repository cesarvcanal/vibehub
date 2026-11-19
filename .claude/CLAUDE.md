# vibehub — Claude Code (porta de entrada)

Este arquivo ensina o Claude Code a **trabalhar** neste repositório: qual skill usar em cada situação, em que ordem, com quais ferramentas e como orquestrar subagentes. As **regras do projeto** (código, testes, acesso, commits e PRs) moram só no [`AGENTS.md`](../AGENTS.md), importado abaixo.

## 1. AGENTS.md primeiro, sempre

@../AGENTS.md

- **Em toda tarefa, consulte o `AGENTS.md`.** Antes de editar, abra as seções que o trecho toca e confronte cada linha nova com elas. Antes de abrir PR ou de cada push de correção, faça o mesmo com o diff inteiro.
- **O `AGENTS.md` vence.** Se este arquivo, uma skill, um subagente ou o hábito do arquivo vizinho apontam para um lado e o `AGENTS.md` para outro, vale o `AGENTS.md`.
- **Cada coisa no seu arquivo.** Regra de código nova vai para o `AGENTS.md`; aprendizado de ambiente (porta, runner, flakiness) vai para os Aprendizados do `CLAUDE.local.md` via `vibehub_brain_learn`. Aqui entra só o que é do Claude Code: skill, ferramenta, slash command, subagente.

## 2. Skill é a máquina: use sempre

A skill traz o método pronto e testado (os passos, a ordem, os critérios de pronto), e você entra com o julgamento.

- **Antes de cada etapa**, ache no mapa da seção 4 a skill da situação e invoque-a pela ferramenta `Skill`, sem esperar o usuário pedir.
- **Mais de uma serve?** Primeiro a de processo (debugging, brainstorming, TDD), depois a de execução (frontend, design).
- **Nenhuma skill cobre a etapa?** Siga o método à mão e diga ao usuário qual etapa ficou sem skill.
- **A skill do mapa não aparece na sua lista?** Os plugins do mapa estão habilitados em [`settings.json`](settings.json), mas o `enabledPlugins` só liga plugin **já instalado no perfil do Claude**; quem instala é a tela de Plugins do vibehub, por instalação. Siga o mesmo processo à mão e avise quem cuida da instalação.
- **A skill dita o método; o `AGENTS.md` dita a regra.** Se uma skill pede algo que o `AGENTS.md` proíbe (outro formato de commit ou PR, comentário no código, `let`), siga o método dela e a regra do `AGENTS.md`.

## 3. Ordem de trabalho

1. **Entender e perguntar.** A pergunta da §12 do `AGENTS.md` ("Como perguntar ao usuário") sai pela `AskUserQuestion`: a marca da recomendada é "(Recomendado)" no rótulo, e a saída livre ("Other") a ferramenta já põe.
2. **Diagnosticar ou desenhar.**
   - Bug: `superpowers:systematic-debugging`.
   - Feature ou mudança de comportamento: `superpowers:brainstorming`.
   - Tela nova ou redesenho: protótipo aprovado antes do React, como Artifact quando o ambiente oferece a ferramenta `Artifact`, senão como página HTML local.
3. **Planejar.** Tarefa de várias etapas: `superpowers:writing-plans`.
4. **Implementar em TDD.** `superpowers:test-driven-development`, com o vermelho visto antes do verde.
5. **Fechamento** (seção 6): simplificação e code review independentes.
6. **Verificar antes de dizer "pronto".** `superpowers:verification-before-completion`, depois de aplicar o que a revisão achou.
7. **Entrega** (seção 7), pela §14 do `AGENTS.md`.

## 4. Mapa: situação → skill

| Situação | Skill |
|----------|-------|
| **Entender e desenhar** | |
| Feature nova, mudança de comportamento, desenho com alternativas | `superpowers:brainstorming` |
| Feature grande guiada de ponta a ponta (explorar → arquitetar → implementar → revisar) | `feature-dev:feature-dev` |
| Pôr à prova um plano ou ideia com perguntas duras | `mattpocock-skills:grilling` |
| Desenhar a interface de um módulo, decidir onde passa a fronteira | `mattpocock-skills:codebase-design` |
| Tela nova ou redesenho, antes do código | Artifact (`quickstart`), se o ambiente oferece a ferramenta, + `frontend-design:frontend-design` |
| Revisar tela existente, acessibilidade, layout responsivo | `ui-design:design-review` · `ui-design:accessibility-audit` · `ui-design:responsive-design` |
| **Bug** | |
| Bug, teste falhando, comportamento que ninguém explica | `superpowers:systematic-debugging` |
| **Planejar e executar** | |
| Tarefa de várias etapas | `superpowers:writing-plans` |
| Executar o plano você mesmo | `superpowers:executing-plans` |
| Executar o plano com subagentes, uma tarefa por agente | `superpowers:subagent-driven-development` |
| Duas ou mais tarefas independentes em paralelo | `superpowers:dispatching-parallel-agents` |
| **Código** | |
| Escrever feature ou correção | `superpowers:test-driven-development` |
| Refatorar ou simplificar código que escreveu ou tocou | `/simplify` · subagente `code-simplifier:code-simplifier` |
| Modernizar código legado | subagente `code-refactoring:legacy-modernizer` |
| Ver a mudança rodando (tela, fluxo) | `run` · MCP `navegador`, com o back e o front isolados da §12 do `AGENTS.md` |
| Medir performance (render, carregamento, `docker exec` por ação) | Sem skill: medir antes e depois no ambiente isolado e pôr os números no PR (§8 do `AGENTS.md`) |
| **Verificar e revisar** | |
| Antes de afirmar que está pronto, passando ou corrigido | `superpowers:verification-before-completion` |
| Achar bug no diff ou num PR, conferir se o código segue as regras | `/code-review` (o `ultra`, faturado, só a pedido do usuário) |
| Revisão independente por um subagente sem o seu contexto | `superpowers:requesting-code-review` |
| Recebeu review (humano ou bot) | `superpowers:receiving-code-review` |
| Segurança das mudanças pendentes | `security-review` |
| **Documentação** | |
| Editar o `AGENTS.md` ou este arquivo | `mattpocock-skills:writing-for-agents` · `claude-md-management:claude-md-improver` |
| **Commit e PR** | Sem skill: direto pela §14 do `AGENTS.md`. As skills `commit-commands:*` fazem um commit único sem Gitmoji, e `mattpocock-skills:pr` usa outro modelo de descrição; as duas contrariam a §14. |

O comando nativo `/code-review` tem níveis de esforço; o plugin `code-review` não é habilitado aqui para não disputar o nome.

## 5. Subagentes: a escrita é delegável, a responsabilidade não

- **Chegue ao plano com o usuário:** entenda a demanda, mostre o melhor caminho, questione e proponha antes de executar. Discordar com fundamento é parte do papel.
- **Subagente corrige o que vê.** O agente que já abriu o trecho e viu o defeito conserta ali mesmo, dentro de um pacote fechado que não cruza com o de outro agente. Feature grande se fatia antes de despachar. Mudança pequena, ou que atravessa muitos arquivos, você escreve. O `git diff` é seu: quem delegou responde pelo resultado.
- **Verifique na fonte.** Saída de subagente é candidata, não verdade: confira no working tree o que ele relatou e o que escreveu. Ressalva do tipo "não auditei X" se resolve abrindo o X.
- **Paralelismo é multi-dispatch seu.** O `settings.json` permite profundidade 2 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`): um subagente pode abrir um nível a mais para ler ou pesquisar, mas não para paralelizar escrita. Paralelismo real são vários agentes numa única mensagem, cada um dono de um pacote que não cruza com os outros; dois agentes na mesma working tree sobrescrevem um ao outro em silêncio. Trabalho que precisa de branch própria vai para outro card do board (`vibehub_send_to_terminal`), não para um subagente.

## 6. Fechamento: revisão agnóstica contra o AGENTS.md

É o passo 8 da §12 do `AGENTS.md`, antes da entrega, sem esperar ser mandado. **Agnóstico** = o prompt de cada subagente leva só como achar o diff e as mensagens dos commits (`git fetch origin main`, `git diff origin/main...HEAD` e `git log origin/main..HEAD`), o caminho do `AGENTS.md` e o pedido, nunca uma justificativa escrita para o revisor nem a conversa: quem escreveu não revisa o próprio raciocínio. As mensagens dos commits entram porque são o que o autor afirma, e o revisor as confere.

1. **Simplificação:** subagente `code-simplifier:code-simplifier`, com o pedido de confrontar cada trecho com as regras e aplicar o que simplifica sem mudar comportamento. Confira o que ele escreveu e rode o recorte de testes.
2. **Code review**, só depois de o primeiro terminar, sobre o diff já simplificado: subagente `general-purpose`, com o pedido de seguir "Como revisar um PR" (§14 do `AGENTS.md`), não mexer no working tree e entregar os achados com severidade e o veredito apto ou não apto. Ele precisa do shell para rodar `git` e os testes que já existem; o teste novo que provaria um achado ele descreve (arquivo, caso e a falha esperada) junto com o cenário, e quem escreve e roda é você. O `feature-dev:code-reviewer` não tem Bash e só serve para uma leitura rápida.
3. Cada achado se confere na fonte e segue a severidade dele (§14 do `AGENTS.md`, "As severidades"): o que bloqueia se corrige em commit próprio, com o teste que prova o defeito quando ele é de comportamento, ou vira pendência deliberada nos Pontos de atenção do PR, nas condições e com o aval da §14 ("A pendência deliberada é julgada"); o que deveria corrigir se aplica em commit próprio; a decisão vira pergunta ao usuário; o menor fica registrado no PR.

## 7. Entrega

- **Dentro de um card do vibehub, só pelo `vibehub_deliver`:** ele faz push, abre o PR, roda o gate (`.vibehub/gate.json`) e mergeia quando autorizado. `git push` direto do runner dá 403 — é esperado.
- **Fora do runner**, a entrega segue os passos de "Como publicar" da §14 do `AGENTS.md` com o `gh`.
- **Merge em `main` é deploy** do vibehub em produção: só com o aval explícito do usuário na conversa.
- **Antes de `authorized: true`**, releia os Pontos de atenção do PR: havendo pendência que bloqueia sem o aval registrado (§14 do `AGENTS.md`), entregue sem `authorized` e peça o aval daquela pendência.

## 8. Onde cada coisa vive

| Camada | Conteúdo |
|--------|----------|
| [`AGENTS.md`](../AGENTS.md) | Regras do projeto, para qualquer agente (fonte única) |
| `.claude/CLAUDE.md` (este) | Como o Claude Code trabalha: skills, ordem, ferramentas, subagentes |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | Resumo público para contribuidores externos; não pode contradizer o `AGENTS.md` |
| [`docs/`](../docs) | Artefatos pontuais (planos, specs), não canônicos |
| `CLAUDE.local.md` (raiz da worktree) | Instruções do projeto escritas pelo vibehub em cada card; a seção `## Aprendizados` recebe o que o `vibehub_brain_learn` descobre (porta CDP, chromium, `/dev/shm`). Não versionado |
| Cérebro (`CLAUDE.md` do perfil) | Instruções globais do runner, editadas na aba Dev → Cérebro. Não versionado |

Assunto que nenhuma dessas camadas documenta → **perguntar** ao usuário, não inventar convenção.
