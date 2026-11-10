# vibehub — Claude Code (porta de entrada)

As regras de código do projeto moram num lugar só: o [`AGENTS.md`](../AGENTS.md) da raiz, importado abaixo. Este arquivo guarda só o que é do Claude Code (orquestração, review, comandos) e não repete nada de lá.

@../AGENTS.md

Assunto não documentado → **perguntar** ao usuário, não inventar convenção.

## Onde cada coisa vive

| Camada | Conteúdo |
|--------|----------|
| [`AGENTS.md`](../AGENTS.md) | Regras de código e de teste (fonte única) |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | Resumo público para contribuidores externos; não pode contradizer o `AGENTS.md` |
| [`docs/`](../docs) | Artefatos pontuais (planos, specs), não canônicos |
| `CLAUDE.local.md` (raiz da worktree) | Instruções do projeto escritas pelo vibehub em cada card; a seção `## Aprendizados` recebe o que o `vibehub_brain_learn` descobre. Não versionado |
| Cérebro (`CLAUDE.md` do perfil) | Instruções globais do runner, editadas na aba Dev → Cérebro. Não versionado |

Regra nova de código vai para o `AGENTS.md`; aprendizado de ambiente (porta, runner, flakiness) vai para os Aprendizados via `vibehub_brain_learn`.

## Workflows: skills da comunidade

Habilitadas em [`settings.json`](settings.json). Use-as em vez de reinventar o passo a passo:

| Quando | Skill |
|--------|-------|
| Bug difícil / comportamento inexplicável / antes de propor fix | `superpowers:systematic-debugging` |
| Feature nova guiada (explorar → arquitetar → implementar → revisar) | `feature-dev:feature-dev` |
| Explorar requisitos antes de feature criativa | `superpowers:brainstorming` |
| Plano de várias etapas / executar plano | `superpowers:writing-plans` · `superpowers:executing-plans` |
| Implementação test-first | `superpowers:test-driven-development` |
| UI nova com alta qualidade visual | `frontend-design:frontend-design` |
| Review independente de diff/PR | `/code-review` · `superpowers:requesting-code-review` |
| Simplificar código existente | `/simplify` · `code-simplifier:code-simplifier` |
| Antes de afirmar que algo está pronto/passando | `superpowers:verification-before-completion` |

## Orquestração: você é o dono do plano e responde pelo código

**Chegue ao plano com o usuário:** entenda a demanda, mostre o melhor caminho, questione e proponha antes de executar. Nunca seja yes-man: discordar com fundamento é parte do papel.

**Subagente corrige o que vê; a escrita é delegável, a responsabilidade não.** Agente que já abriu o trecho e viu o defeito conserta ali mesmo, dentro de um pacote fechado que não cruza com o de outro agente. Feature grande se fatia antes de despachar. Mudança pequena ou que atravessa muitos arquivos, escreva você mesmo. O `git diff` é seu: quem delegou responde pelo resultado.

**Verifique na fonte.** Saída de subagente é candidato, não verdade: confira no working tree o que ele relatou e o que ele escreveu. Ressalva do tipo "não auditei X" se resolve abrindo o X.

**Risco antes de executar.** Antes de ação destrutiva ou irreversível (apagar worktree, volume ou dado de `VIBEHUB_DATA_DIR`, `rm`, force-push, migração de dado persistido, mexer no vibehub em produção), exponha os riscos ao usuário **antes** de agir, com o emoji escalando pela gravidade: 🚨 para risco grande/irreversível, ⚠️ para médio e pequeno. Só siga com o aval.

**Paralelismo é multi-dispatch seu.** Subagente não abre executores paralelos por dentro (profundidade 2). Paralelismo real = vários agentes numa única mensagem, cada um dono de um pacote que não cruza com os outros; dois agentes na mesma working tree = sobrescrita silenciosa. Trabalho que precisa de branch própria vai para outro card do board (`vibehub_send_to_terminal`), não para um subagente.

## Entrega

- **Só pelo `vibehub_deliver`:** ele faz push, abre o PR, roda o gate (`.vibehub/gate.json`) e mergeia quando autorizado. `git push` direto do runner dá 403 — é esperado.
- **Merge em `main` é deploy** do vibehub em produção.
- PR documentado (seções e comentários por bloco do diff), commits atômicos, merge commit, nunca squash.

## Review de diff

Depois de implementar, ou em "audita" / "segue as regras?": `/code-review`. `/code-review ultra` (multi-agente na nuvem, faturado) só quando o usuário pedir.

## Comandos úteis

| Comando | Uso |
|---------|-----|
| `npm run install:all` | Instala `back/` e `front/` |
| `npm --prefix back run dev` · `npm --prefix front run dev` | Backend (tsx watch) e frontend (Vite) em dev |
| `cd back && npx vitest run <arquivo> -t "<caso>"` | Teste do que você tocou (idem em `front/`) |
| `npm run test:changed` | Testes afetados pela branch desde a `main`, o recorte do gate |
| `npx tsc -b` (dentro de `back/` ou `front/`) | Typecheck real (nunca `tsc --noEmit -p`) |
| `npm run build` | Build de back + front |
| `npm --prefix front run storybook` | Storybook dos componentes |
| `gh pr checks <N>` | Suíte inteira, que só roda no CI |

**Testar pela tela sem tocar em produção:** back isolado (`VIBEHUB_PORT=<porta livre> VIBEHUB_DATA_DIR=/tmp/vh-test npx tsx src/index.ts` em `back/`) e front apontando para ele (`VIBEHUB_BACKEND=http://127.0.0.1:<porta> npx vite --port <outra>` em `front/`), navegados pelo MCP `navegador`. Detalhes de ambiente (porta CDP, chromium, `/dev/shm`) estão nos Aprendizados do `CLAUDE.local.md`.
