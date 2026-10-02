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

Cada pessoa commita e empurra como ela mesma, no mesmo card, sem reiniciar sessão. Nada é tirado do
César: quem trabalha nos repositórios dele continua vendo e usando tudo igual — só a autoria muda.

### Critérios de sucesso

- Card aberto pelo César; o Mussa manda um prompt; o commit seguinte sai com autor do Mussa e o push
  com o token do Mussa. O César volta, digita, e a identidade volta pra ele. **Sem matar a sessão.**
- Um usuário sem identidade própria se comporta exatamente como hoje (conexão do projeto →
  `settings.git`). Nada que funciona hoje muda de comportamento.
- O Mussa, logado como `mussa`, troca o próprio PAT sem depender do César.

### Fora de escopo

- **Filtrar os projetos pelo acesso no GitHub** — era a seção F e foi CORTADA em 02/10/2026 a pedido
  do Mussa: "eu não vou ver meus repositórios nem nada, a conta vai continuar pegando os repositórios
  tudo do César". Ele quer só a autoria. O registro de por que o filtro seria um filtro, e não uma
  concessão, fica no histórico deste arquivo caso a ideia volte.
- Trocar o modelo de compartilhamento do vibehub. Quem vê o quê continua decidido pelos
  compartilhamentos do owner, exatamente como hoje.

## Decisões tomadas no briefing

| Decisão | Escolha |
|---|---|
| Senha mínima | Fica em 8+ (`assertPassword` intocado). O `54321` pedido não entra. |
| Escopo da identidade | Token de push **e** nome/e-mail do commit. |
| Cadastro do PAT | Duas portas: o owner configura a de qualquer um na lista de usuários, e cada pessoa configura a sua. Sem autoatendimento, toda rotação de token do Mussa viraria tarefa do César. O PAT é colado na tela de Contas do GitHub — token não passa por chat. |
| Precedência | Identidade do **ator** do card → conexão do projeto → `settings.git`. |
| Quem é o ator | Quem mexeu por último no card (abrir, anexar terminal, mandar prompt). |
| Acesso GitHub | Não entra na visibilidade. Cortado do escopo (ver "Fora de escopo"). |

### Por que o cadastro do PAT tem duas portas

O PAT é da pessoa e vence. Se só o owner pudesse gravá-lo, toda rotação de token do Mussa seria uma
tarefa do César — e o jeito de contornar isso seria o Mussa mandar o token pra ele, que é exatamente
o que não se quer. `PATCH /api/users/:id` (owner, qualquer um) e `PATCH /api/me/git` (cada um, o seu)
são a mesma gravação com dono diferente. Papel e senha seguem só do owner.

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

## Testes

Unitário, nas partes puras:
- `resolveIdentity` — campo por campo: ator completo, ator só com conexão, ator só com nome, ator
  vazio, projeto sem conexão.
- O script de aplicação (`git config` + helper) — inclusive que ele zera a lista de helpers antes.
- A validação de nome/e-mail que vai pra dentro de script bash.

Integração, nas rotas:
- Estampa de ator nos quatro pontos, e **não** estampa em acesso `view`.
- O caso do briefing, ponta a ponta: card aberto pelo César → Mussa manda prompt → a worktree fica
  com `user.email` do Mussa e o arquivo de token com o PAT do Mussa; o César digita → volta.
- `deliver` abre o PR na conta do ator, não na do projeto.
- Autoatendimento: o membro grava a PRÓPRIA identidade e não a de outro; e não consegue mudar papel
  nem senha de ninguém por essa rota.

## Entrega

**Um PR** — com a seção F cortada, sobrou uma unidade lógica só.

Branch `card/mussa-user-vibehub-6930` → PR pra `main`, merge commit. Commits atômicos, como
César Canal.

Pré-requisitos operacionais (não são código):
1. O Mussa cola o PAT dele na tela de GitHub do vibehub, label `mussa`. O token não passa por chat.
2. O César cria o usuário `mussa` com senha de 8+ caracteres e vincula essa conexão a ele.
