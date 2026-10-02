# Identidade por usuário — GitHub, autor do commit e visibilidade

**Data:** 2026-10-02 · **Branch:** `card/mussa-user-vibehub-6930`

## Problema

A instalação tem um usuário (`cesar`) e, por consequência, uma identidade. Quando outra pessoa (o
Mussa) trabalha num card, três coisas saem erradas:

1. **O push sai como o dono do projeto.** A credencial do GitHub é escolhida pelo PROJETO
   (`Project.githubConnectionId`), não por quem está trabalhando.
2. **O autor do commit é global da instalação.** `settings.git.name/email` é gravado uma vez no
   `git config --global` do runner (`back/src/runtime/runner.ts:185`), então todo commit de todo card
   leva o mesmo nome.
3. **O board mostra projetos cujo repositório a pessoa não alcança.** A visibilidade vem só dos
   compartilhamentos do vibehub; o acesso real no GitHub não entra na conta.

Resultado prático: o Mussa trabalha, e o gráfico de contribuição do César cresce.

## Objetivo

Cada pessoa commita e empurra como ela mesma, no mesmo card, sem reiniciar sessão — e só vê projetos
cujo repositório ela de fato alcança no GitHub.

### Critérios de sucesso

- Card aberto pelo César; o Mussa manda um prompt; o commit seguinte sai com autor do Mussa e o push
  com o token do Mussa. O César volta, digita, e a identidade volta pra ele. **Sem matar a sessão.**
- Um usuário sem identidade própria se comporta exatamente como hoje (conexão do projeto →
  `settings.git`). Nada que funciona hoje muda de comportamento.
- Um membro não vê projeto cujo repositório seu PAT não alcança, mesmo que esteja compartilhado.
- Queda da API do GitHub não apaga o board de ninguém.

### Fora de escopo

- Tela de autoatendimento pra pessoa cadastrar o próprio PAT (decisão do César: o cadastro fica na
  tela de usuários que o owner já usa).
- Trocar o modelo de compartilhamento do vibehub pelo do GitHub. O acesso do GitHub **filtra**, não
  **concede** — ver "Decisões".

## Decisões tomadas no briefing

| Decisão | Escolha |
|---|---|
| Senha mínima | Fica em 8+ (`assertPassword` intocado). O `54321` pedido não entra. |
| Escopo da identidade | Token de push **e** nome/e-mail do commit. |
| Cadastro do PAT | Sem tela nova: a lista de usuários do owner ganha o vínculo. O PAT é colado pelo dono dele na tela de GitHub que já existe — token não passa por chat. |
| Precedência | Identidade do **ator** do card → conexão do projeto → `settings.git`. |
| Quem é o ator | Quem mexeu por último no card (abrir, anexar terminal, mandar prompt). |
| Acesso GitHub | **Filtra** o que já foi compartilhado. Não concede acesso por si. |
| GitHub indisponível | Mostra (último resultado em cache) com aviso. Fail-open. |

### Por que filtrar e não conceder

O runner é **um container compartilhado por todos os cards**. De dentro do terminal de qualquer card
se lê `/root/.vibehub/gh/*.token` (o token GitHub de todos os outros cards), os tokens OAuth das
contas Claude em `/root/.claude-profiles/` e as worktrees dos outros projetos em `/work`. Hoje isso é
aceitável porque entrar num card é um ato deliberado do owner. Se o convite num repositório
concedesse acesso sozinho, ser colaborador de **um** repo passaria a dar, na prática, a credencial de
todos. O filtro entrega o que foi pedido (não ver projeto de repo que você não alcança) sem essa
troca.

## Desenho

### A. Identidade por usuário

Novo store `userGit.json` (`JsonStore`, no padrão de `users.json`), separado do registro de usuário
porque `PublicUser` viaja pro front e isto não precisa:

```ts
interface UserGitIdentity {
  userId: string;
  /** Conexão GitHub desta pessoa (id em githubConnections). Ausente = usa a do projeto. */
  githubConnectionId?: string;
  /** Autor do commit. Ambos ausentes = usa settings.git. */
  gitName?: string;
  gitEmail?: string;
}
```

Gravado por `PATCH /api/users/:id` (já `requireOwner`). O front acrescenta na linha de cada usuário
um seletor de conexão + dois campos de texto. A conexão é validada contra `listGithubConnections()`:
um id pendurado faria todo push daquela pessoa falhar com credencial inexistente — mesmo cuidado que
`Project.githubConnectionId` já tem.

### B. Ator do card

`Card` ganha dois campos (`back/src/services/board/registry.ts`):

```ts
/** Quem mexeu por último neste card — de quem é a identidade de commit/push em vigor. */
actorUserId?: string;
actorAt?: number;
```

Estampados em quatro pontos que já conhecem o usuário logado:

| Ponto | Arquivo |
|---|---|
| `POST /api/cards/:id/open` | `back/src/routes/session.ts:214` |
| `GET /api/cards/:id/terminal` (websocket) | `back/src/routes/session.ts:430` |
| `POST /api/cards/:id/messages` | `back/src/routes/session.ts:334` |
| `GET /api/cards/:id/sdk` (websocket) | `back/src/routes/cardSdk.ts:62` |

Estampar é idempotente e barato: se o ator não mudou, não escreve nada (evita um write por frame de
websocket). Quando MUDA, dispara a reaplicação da seção D.

Anexar o terminal conta como "mexer" de propósito: abrir o card do César pra dar continuidade é
exatamente o caso do briefing. Só leitura (`view`) não estampa — quem não pode trabalhar não pode
virar autor.

### C. Resolução

Uma função pura, consumida por todo mundo:

```ts
interface EffectiveIdentity { token?: string; name: string; email: string; connectionId?: string }
function resolveIdentity(opts: {
  actor?: UserGitIdentity; project: Project; settings: Settings;
}): EffectiveIdentity
```

Ordem, campo por campo (não é "o primeiro objeto completo que aparecer"): a conexão vem do ator se
ele tiver uma, senão do projeto, senão da primeira conexão — o mesmo fallback do clone de hoje.
Nome/e-mail vêm do ator se definidos, senão de `settings.git`.

Consumidores: a abertura do card (`workspace.ts:625`), o attach (`cardAttachArgs`) e o `deliver`
(`back/src/services/maestro/deliver.ts`, que hoje chama `tokenFor(project.githubConnectionId)` fixo).

### D. Aplicação no runner — o ponto crítico

Hoje o `GH_TOKEN` é exportado **uma vez**, no nascimento da sessão tmux
(`workspace.ts:119`: `export GH_TOKEN="$(cat <file>)"`). Reescrever o arquivo do token num card já
aberto **não muda** a variável já exportada: a troca de ator não pegaria e o push sairia
silenciosamente como a pessoa errada — o pior defeito possível aqui, porque é silencioso. A aplicação
muda de "exportar no boot" pra "ler na hora":

1. **Autor do commit** — `git config user.name/user.email` **na worktree do card**. O git lê no
   momento do commit, então vale na sessão viva. Nada de reiniciar.
2. **Push** — `credential.helper` local na worktree, que lê o arquivo de token do card a cada
   chamada. Precisa **zerar a lista** antes (`git config --local credential.helper ""`): o git
   consulta os helpers na ordem system → global → local e usa o primeiro que responder, e o
   `gh auth git-credential` global responderia com o `GH_TOKEN` velho.
3. **`gh` (abrir PR dentro do terminal)** — um shim em `/root/.bashrc` que re-exporta `GH_TOKEN` do
   arquivo do card antes de delegar ao `gh` real. Sem isso, `gh pr create` digitado num terminal vivo
   usa o token do boot.

Trocar de ator = reescrever o arquivo do token (já existe: `writeGhTokenLines`) + dois `git config` na
worktree. Nenhuma sessão morre, nenhuma conversa se perde.

O `deliver` roda server-side e já monta o seu próprio `GH_TOKEN` por comando
(`ghTokenPreamble`), então pra ele basta trocar a origem do token pela resolução da seção C.

### E. Nome no chat

**Já existe e não precisa de código.** `MessageOrigin` é gravado no envio
(`back/src/services/chat/provenance.ts`), viaja no evento de histórico (`sdk/manager.ts:546`) e o
front desenha a etiqueta (`SenderTag`, `front/src/features/board/components/ChatView.tsx:445`).
Hoje não aparece nada porque existe um só usuário: `originRole` classifica a mensagem de quem está
olhando como `self`, e `self` não leva etiqueta. Criado o segundo usuário, a atribuição aparece
sozinha.

Fica registrado como pendência do César, não como escopo: se ele quiser a etiqueta **também** nas
próprias mensagens, é mudar `originRole`.

### F. Visibilidade filtrada pelo GitHub

Checagem de acesso: `GET /repos/{owner}/{repo}` com o PAT da pessoa — 200 = alcança, 404 = não
alcança. Uma chamada por projeto, não a listagem paginada de repos.

Cache em memória, chave `${connectionId}:${repoFullName}`:

```ts
interface RepoAccessEntry { ok: boolean; at: number }   // TTL 5 min
```

Fail-open, como decidido: erro de rede/401/403 **não** vira "não alcança" — devolve a última entrada
conhecida; sem nenhuma, devolve `ok: true` com `stale: true`, e o front mostra o aviso de "não deu
pra conferir no GitHub". Só o **404 explícito** esconde.

Aplicado em `back/src/auth/access.ts`, nos cinco pontos, não só nas listas — esconder o projeto da
lista e deixar a URL direta funcionando seria uma falsa trava: `canAccessProject`, `cardLevel`,
`canAccessCard`, `visibleProjects`, `visibleCards`.

Regras:
- **Owner não é filtrado.** A instalação é dele.
- **Membro sem identidade GitHub própria não é filtrado** — nada a checar, comportamento de hoje.
- **Projeto sem repositório** (`repoFullName` ausente, projeto scratch): nada a checar, visível.

## Testes

Unitário, nas partes puras:
- `resolveIdentity` — campo por campo: ator completo, ator só com conexão, ator só com nome, ator
  vazio, projeto sem conexão.
- O script de aplicação (`git config` + helper) — inclusive que ele zera a lista de helpers antes.
- `pickRepoAccess` sobre o cache — fresco, vencido, 404, erro de rede com e sem entrada anterior.

Integração, nas rotas:
- Estampa de ator nos quatro pontos, e **não** estampa em acesso `view`.
- O caso do briefing, ponta a ponta: card aberto pelo César → Mussa manda prompt → a worktree fica
  com `user.email` do Mussa e o arquivo de token com o PAT do Mussa; o César digita → volta.
- `deliver` abre o PR na conta do ator, não na do projeto.
- Visibilidade: membro com PAT que não alcança o repo não vê o projeto nem na lista nem pela URL
  direta; GitHub fora do ar mantém a lista com `stale`.

## Entrega

**Dois PRs**, porque são duas unidades lógicas e a regra da casa é PR pequeno e específico:

1. **Identidade por usuário** (seções A–D): o que resolve o commit/push sair na pessoa certa. Entrega
   valor sozinho.
2. **Filtro de visibilidade pelo GitHub** (seção F): depende de (1) só porque reusa a identidade
   GitHub do usuário. Separado, dá pra reverter sem desfazer a identidade.

Branch `card/mussa-user-vibehub-6930` → PR pra `main`, merge commit. Commits atômicos, como
César Canal.

Pré-requisitos operacionais (não são código):
1. O Mussa cola o PAT dele na tela de GitHub do vibehub, label `mussa`. O token não passa por chat.
2. O César cria o usuário `mussa` com senha de 8+ caracteres e vincula essa conexão a ele.
