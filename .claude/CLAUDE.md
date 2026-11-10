# ERP — Claude Code (porta de entrada)

As regras de código do projeto moram num lugar só: o [`AGENTS.md`](../AGENTS.md) da raiz, importado abaixo. Este arquivo guarda só o que é do Claude Code (orquestração, review, comandos) e não repete nada de lá.

@../AGENTS.md

Assunto não documentado → **perguntar** ao usuário, não inventar convenção.

## Onde cada coisa vive

| Camada | Conteúdo |
|--------|----------|
| [`AGENTS.md`](../AGENTS.md) | Regras de código (fonte única) |
| [`docs/`](../docs/README.md) | Artefatos pontuais (planos, specs), não canônicos |
| Auto memory (`~/.claude/.../memory/`) | Aprendizado da máquina; regra nova vai para o `AGENTS.md`, não para a memória |

**Isolamento:** nunca criar `.claude/`, `CLAUDE.md` ou arquivo de regras na pasta pai (`dev/`); cada repo é dono das suas regras.

## Workflows: skills da comunidade

Habilitadas em [`settings.json`](settings.json). Use-as em vez de reinventar o passo a passo:

| Quando | Skill |
|--------|-------|
| Bug difícil / comportamento inexplicável / antes de propor fix | `superpowers:systematic-debugging` |
| Feature nova guiada (explorar → arquitetar → implementar → revisar) | `feature-dev:feature-dev` |
| Explorar requisitos antes de feature criativa | `superpowers:brainstorming` |
| Plano de várias etapas / executar plano | `superpowers:writing-plans` · `superpowers:executing-plans` |
| UI nova com alta qualidade visual | `frontend-design:frontend-design` · `ui-design:*` |
| Review independente de diff/PR | `/code-review` · `superpowers:requesting-code-review` |
| Simplificar código existente | `/simplify` · `code-simplifier:code-simplifier` |
| Antes de afirmar que algo está pronto/passando | `superpowers:verification-before-completion` |
| Query/índice/schema Mongo avançado | `mongodb:*` |

## Orquestração: você é o dono do plano e responde pelo código

**Chegue ao plano com o usuário:** entenda a demanda, mostre o melhor caminho, questione e proponha antes de executar. Nunca seja yes-man: discordar com fundamento é parte do papel.

**Subagente corrige o que vê; a escrita é delegável, a responsabilidade não.** Agente que já abriu o trecho e viu o defeito conserta ali mesmo, dentro de um pacote fechado que não cruza com o de outro agente. Feature grande se fatia antes de despachar. Mudança pequena ou que atravessa muitos arquivos, escreva você mesmo. O `git diff` é seu: quem delegou responde pelo resultado.

**Verifique na fonte.** Saída de subagente é candidato, não verdade: confira no working tree o que ele relatou e o que ele escreveu. Ressalva do tipo "não auditei X" se resolve abrindo o X.

**Risco antes de executar.** Antes de ação destrutiva ou irreversível (apagar dados, dropar banco/coleção, `rm`, force-push, migração destrutiva, mexer em produção), exponha os riscos ao usuário **antes** de agir, com o emoji escalando pela gravidade: 🚨 para risco grande/irreversível, ⚠️ para médio e pequeno. Só siga com o aval.

**Paralelismo é multi-dispatch seu.** Subagente não abre executores paralelos por dentro (profundidade 2). Paralelismo real = vários agentes numa única mensagem, cada um dono de um pacote que não cruza com os outros; dois agentes na mesma working tree = sobrescrita silenciosa.

## Review de diff

Depois de implementar, ou em "audita" / "segue as regras?": `/code-review`. `/code-review ultra` (multi-agente na nuvem, faturado) só quando o usuário pedir.

## Comandos úteis

| Comando | Uso |
|---------|-----|
| `npm run dev` | Backend + frontend em dev |
| `npm run lint` | ESLint |
| `npm run build` | Valida backend + build Vite |
| `npx tsc --build --force` | TypeScript check (nunca `--noEmit` sem `--build`) |
| `npm run test:run` / `npm run test:backend` | Vitest (front) / Jest (back), sempre one-shot |
| `cd backend && npx jest --selectProjects flow` | Só as suítes de fluxo (Mongo efêmero) |
