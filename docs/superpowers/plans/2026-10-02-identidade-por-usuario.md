# Identidade por usuário — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cada pessoa commita e empurra como ela mesma, no mesmo card, sem reiniciar a sessão.

**Architecture:** A identidade (conexão GitHub + nome/e-mail de commit) passa a morar no USUÁRIO, num
store novo `userGit.json`. O card registra quem mexeu por último (`actorUserId`). Uma função pura
resolve a identidade em vigor (ator → projeto → instalação) e três consumidores a usam: abrir card,
anexar terminal e `deliver`. A aplicação no runner muda de "exportar no boot da sessão" pra "ler o
arquivo na hora da chamada", porque é a única forma de a troca de ator pegar num terminal já aberto.

**Tech Stack:** TypeScript (ESM, NodeNext), Fastify 5, vitest, React 19 + Tailwind no front.

**Spec:** `docs/superpowers/specs/2026-10-02-identidade-por-usuario-design.md`

## Global Constraints

- Senha mínima **8 caracteres** — `assertPassword` NÃO muda.
- Token GitHub **nunca** em argv, nunca em log, nunca em `.git/config`: só arquivo mode 600 escrito
  por stdin, como `writeGhTokenLines` já faz.
- Valores concretos desta entrega: usuário `mussa`, `gitName` = `wellesley-mussolini`,
  `gitEmail` = `xerif.off@gmail.com`.
- Comportamento de hoje é o **fallback**: usuário sem identidade própria → conexão do projeto →
  `settings.git`. Nenhum teste existente pode mudar de resultado.
- Typecheck só vale com `npx tsc -b` (os `tsconfig.json` da raiz são solution com project
  references; `tsc --noEmit -p tsconfig.json` dá verde falso).
- Comentários de código em inglês, nomes de teste em português — convenção do repo.
- Commits como César Canal `<cesarvcanal@gmail.com>`, sem coautoria.

## Review Focus

Classes de entrada que a spec implica e que nenhum teste de tarefa exercita por acaso — cada uma
ganhou teste na tarefa dona do código:

1. **Ator removido do vibehub** enquanto é dono do card: `resolveIdentity` recebe `actor: undefined` e
   precisa cair no projeto, não estourar. (Tarefa 3)
2. **Ator com conexão apagada** (`githubConnectionId` aponta pra conexão que o owner removeu): o
   push tem de cair na conexão do projeto, não falhar com credencial inexistente. (Tarefa 3)
3. **Ator com só metade da identidade** (conexão sim, nome/e-mail não, ou o inverso): a resolução é
   campo por campo, não objeto inteiro. (Tarefa 3)
4. **Acesso `view` mandando prompt**: não pode estampar ator — quem não trabalha não pode virar autor
   do commit. (Tarefa 4)
5. **Nome/e-mail com caractere de shell** (`'`, `$(`, newline): vão pra dentro de script bash, então
   passam por `shQuote` e por validação de e-mail. (Tarefa 5)

---

### Task 1: Store da identidade por usuário

**Files:**
- Create: `back/src/auth/userGit.ts`
- Test: `back/src/auth/userGit.test.ts`

**Interfaces:**
- Consumes: `JsonStore` de `back/src/store/jsonStore.ts`, `dataPath` de `back/src/config/env.js`.
- Produces:
  - `interface UserGitIdentity { userId: string; githubConnectionId?: string; gitName?: string; gitEmail?: string }`
  - `getUserGit(userId: string): Promise<UserGitIdentity | null>`
  - `setUserGit(userId: string, patch: { githubConnectionId?: string | null; gitName?: string | null; gitEmail?: string | null }): Promise<UserGitIdentity>`
  - `assertGitEmail(email: string): string`
  - `assertGitName(name: string): string`
  - `resetUserGitForTesting(): void`

- [ ] **Step 1: Write the failing test**

`back/src/auth/userGit.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";

async function load() {
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  const mod = await import("./userGit.js");
  mod.resetUserGitForTesting();
  return mod;
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-usergit-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("identidade git por usuário", () => {
  it("quem nunca foi configurado não tem identidade", async () => {
    const { getUserGit } = await load();
    expect(await getUserGit("u1")).toBeNull();
  });

  it("guarda e devolve os três campos", async () => {
    const { setUserGit, getUserGit } = await load();
    await setUserGit("u1", { githubConnectionId: "c1", gitName: "wellesley-mussolini", gitEmail: "xerif.off@gmail.com" });
    expect(await getUserGit("u1")).toEqual({
      userId: "u1", githubConnectionId: "c1", gitName: "wellesley-mussolini", gitEmail: "xerif.off@gmail.com",
    });
  });

  it("patch parcial não apaga o que não foi mandado", async () => {
    const { setUserGit, getUserGit } = await load();
    await setUserGit("u1", { githubConnectionId: "c1", gitName: "mussa", gitEmail: "m@x.com" });
    await setUserGit("u1", { gitName: "wellesley-mussolini" });
    const got = await getUserGit("u1");
    expect(got?.gitName).toBe("wellesley-mussolini");
    expect(got?.githubConnectionId).toBe("c1");
    expect(got?.gitEmail).toBe("m@x.com");
  });

  it("null limpa o campo (volta a herdar)", async () => {
    const { setUserGit, getUserGit } = await load();
    await setUserGit("u1", { githubConnectionId: "c1", gitName: "mussa" });
    await setUserGit("u1", { githubConnectionId: null });
    expect((await getUserGit("u1"))?.githubConnectionId).toBeUndefined();
  });

  it("e-mail e nome com caractere de shell são recusados", async () => {
    const { assertGitEmail, assertGitName } = await load();
    expect(() => assertGitEmail("a$(whoami)@x.com")).toThrow();
    expect(() => assertGitEmail("sem-arroba")).toThrow();
    expect(() => assertGitName("mussa'; rm -rf /")).toThrow();
    expect(() => assertGitName("linha\numa")).toThrow();
    expect(assertGitEmail(" xerif.off@gmail.com ")).toBe("xerif.off@gmail.com");
    expect(assertGitName(" Wellesley Mussolini ")).toBe("Wellesley Mussolini");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back && npx vitest run src/auth/userGit.test.ts`
Expected: FAIL — `Cannot find module './userGit.js'`

- [ ] **Step 3: Write minimal implementation**

`back/src/auth/userGit.ts`:

```ts
import { JsonStore } from "../store/jsonStore.js";
import { dataPath } from "../config/env.js";

/**
 * GIT IDENTITY PER USER — who a card's commits are authored by, and which GitHub connection its
 * pushes use, decided by the PERSON doing the work instead of by the install.
 *
 * Kept OUT of `users.json` on purpose: that document's records travel to the front as `PublicUser`,
 * and the connection a person pushes with is not part of their login. A user with no record here
 * behaves exactly like before this file existed — the project's connection and `settings.git`.
 *
 * Only the owner writes it (PATCH /api/users/:id). The values land in a bash script inside the
 * runner, so both strings are validated here, at the door, and shell-quoted at the other end.
 */

export interface UserGitIdentity {
  userId: string;
  /** This person's GitHub connection (an id in `githubConnections`). Absent = the project's. */
  githubConnectionId?: string;
  /** Commit author. Absent = `settings.git`. */
  gitName?: string;
  gitEmail?: string;
}

interface UserGitDoc { identities: UserGitIdentity[] }

const store = new JsonStore<UserGitDoc>(
  dataPath("userGit.json"),
  () => ({ identities: [] }),
  (raw) => ({ identities: (raw as UserGitDoc)?.identities ?? [] }),
);

/** No control characters, no quote, no shell expansion — it ends up inside a bash script. PURE. */
const GIT_NAME_RE = /^[^\p{C}'"`$\\]{1,80}$/u;
/** Deliberately stricter than RFC 5322: an address, nothing a shell could read. PURE. */
const GIT_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function assertGitName(name: string): string {
  const v = String(name ?? "").trim();
  if (!GIT_NAME_RE.test(v)) throw new Error("invalid commit name (1-80 chars, no quotes or shell characters)");
  return v;
}

export function assertGitEmail(email: string): string {
  const v = String(email ?? "").trim();
  if (!GIT_EMAIL_RE.test(v)) throw new Error(`invalid commit e-mail: '${email}'`);
  return v;
}

export async function getUserGit(userId: string): Promise<UserGitIdentity | null> {
  const id = String(userId ?? "");
  if (!id) return null;
  return (await store.load()).identities.find((i) => i.userId === id) ?? null;
}

/**
 * Writes one person's identity. A field left out is UNTOUCHED; a field set to null is CLEARED (back
 * to inheriting). The connection id is NOT validated here — see the route, which checks it against
 * the connections that exist.
 */
export async function setUserGit(
  userId: string,
  patch: { githubConnectionId?: string | null; gitName?: string | null; gitEmail?: string | null },
): Promise<UserGitIdentity> {
  const id = String(userId ?? "");
  if (!id) throw new Error("user id is required");
  // Validate BEFORE mutating: the document lives in a cache shared with the next mutation, so a
  // half-applied patch whose last field throws would survive in memory and get persisted later.
  const name = patch.gitName === undefined || patch.gitName === null ? patch.gitName : assertGitName(patch.gitName);
  const email = patch.gitEmail === undefined || patch.gitEmail === null ? patch.gitEmail : assertGitEmail(patch.gitEmail);
  return await store.mutate((doc) => {
    let entry = doc.identities.find((i) => i.userId === id);
    if (!entry) {
      entry = { userId: id };
      doc.identities.push(entry);
    }
    if (patch.githubConnectionId !== undefined) {
      if (patch.githubConnectionId === null) delete entry.githubConnectionId;
      else entry.githubConnectionId = patch.githubConnectionId;
    }
    if (name !== undefined) {
      if (name === null) delete entry.gitName;
      else entry.gitName = name;
    }
    if (email !== undefined) {
      if (email === null) delete entry.gitEmail;
      else entry.gitEmail = email;
    }
    return { ...entry };
  });
}

export function resetUserGitForTesting(): void {
  store.resetForTesting();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd back && npx vitest run src/auth/userGit.test.ts`
Expected: PASS (5 testes)

- [ ] **Step 5: Commit**

```bash
git add back/src/auth/userGit.ts back/src/auth/userGit.test.ts
git commit -m "feat(identidade): store da identidade git por usuário"
```

---

### Task 2: Rota do owner pra gravar a identidade

**Files:**
- Modify: `back/src/routes/users.ts:38-57` (o `PATCH /api/users/:id`)
- Test: `back/src/routes/users.test.ts` (acrescentar ao describe existente)

**Interfaces:**
- Consumes: `setUserGit`, `getUserGit` da Tarefa 1; `listGithubConnections` de `back/src/services/board/registry.js`.
- Produces: `PATCH /api/users/:id` aceita `githubConnectionId`, `gitName`, `gitEmail` (cada um
  opcional, `null` limpa) e devolve `{ user, git }`; `GET /api/users` devolve cada usuário com
  `git?: { githubConnectionId?, gitName?, gitEmail? }`.

- [ ] **Step 1: Write the failing test**

Acrescente em `back/src/routes/users.test.ts`, dentro do describe de rotas de usuário (reusa o
`boot()`, o login de owner e o helper de criar membro que o arquivo já tem):

```ts
it("o owner vincula conexão GitHub e autor do commit a um membro", async () => {
  const cookie = await signInAsOwner();
  const id = await createMember("mussa", "Multi@102030");
  const res = await app.inject({
    method: "PATCH", url: `/api/users/${id}`, headers: { cookie },
    payload: { gitName: "wellesley-mussolini", gitEmail: "xerif.off@gmail.com" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().git).toMatchObject({ gitName: "wellesley-mussolini", gitEmail: "xerif.off@gmail.com" });

  const list = await app.inject({ method: "GET", url: "/api/users", headers: { cookie } });
  expect(list.json().users.find((u: { id: string }) => u.id === id).git.gitEmail).toBe("xerif.off@gmail.com");
});

it("conexão GitHub inexistente é recusada", async () => {
  const cookie = await signInAsOwner();
  const id = await createMember("mussa", "Multi@102030");
  const res = await app.inject({
    method: "PATCH", url: `/api/users/${id}`, headers: { cookie },
    payload: { githubConnectionId: "nao-existe" },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/github/i);
});

it("um membro não grava a identidade de ninguém, nem a própria", async () => {
  const ownerCookie = await signInAsOwner();
  const id = await createMember("mussa", "Multi@102030");
  const memberCookie = await signIn("mussa", "Multi@102030");
  const res = await app.inject({
    method: "PATCH", url: `/api/users/${id}`, headers: { cookie: memberCookie },
    payload: { gitName: "outro" },
  });
  expect(res.statusCode).toBe(403);
  expect(ownerCookie).toBeTruthy();
});
```

Se `signInAsOwner`/`signIn`/`createMember` tiverem outro nome no arquivo, use os helpers que já
existem lá — não crie helper novo.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back && npx vitest run src/routes/users.test.ts`
Expected: FAIL — a resposta não tem `git`

- [ ] **Step 3: Write minimal implementation**

Em `back/src/routes/users.ts`, acrescente aos imports:

```ts
import { getUserGit, setUserGit } from "../auth/userGit.js";
import { listGithubConnections } from "../services/board/registry.js";
```

Troque o corpo do `GET /api/users` por:

```ts
app.get("/api/users", { preHandler: requireOwner }, async (_req, reply) => {
  const users = await listUsers();
  // The identity rides WITH the user: the screen that edits it is the user list, and a second
  // round-trip per row to fetch it would be the same data arriving later.
  const decorated = await Promise.all(users.map(async (u) => {
    const git = await getUserGit(u.id);
    return git ? { ...u, git: { githubConnectionId: git.githubConnectionId, gitName: git.gitName, gitEmail: git.gitEmail } } : u;
  }));
  return await reply.send({ users: decorated });
});
```

No `PATCH`, amplie o Body e trate os três campos novos ANTES de responder:

```ts
app.patch<{
  Params: { id: string };
  Body: {
    password?: string; role?: string;
    githubConnectionId?: string | null; gitName?: string | null; gitEmail?: string | null;
  };
}>(
  "/api/users/:id", { preHandler: requireOwner },
  async (req, reply) => {
    const { password, role, githubConnectionId, gitName, gitEmail } = req.body ?? {};
    try {
      if (role !== undefined) await setRole(req.params.id, assertRole(role));
      if (password !== undefined) await changePassword(req.params.id, password);
      // A DANGLING connection id would make every push of this person fail with a credential that
      // does not exist — the same guard `Project.githubConnectionId` already has.
      if (githubConnectionId !== undefined && githubConnectionId !== null) {
        const connections = await listGithubConnections();
        if (!connections.some((c) => c.id === githubConnectionId)) {
          return await reply.code(400).send({ error: `GitHub connection '${githubConnectionId}' does not exist` });
        }
      }
      if (githubConnectionId !== undefined || gitName !== undefined || gitEmail !== undefined) {
        await setUserGit(req.params.id, { githubConnectionId, gitName, gitEmail });
      }
      const user = (await listUsers()).find((u) => u.id === req.params.id);
      if (!user) return await reply.code(404).send({ error: "user not found" });
      const git = await getUserGit(req.params.id);
      logger.info(
        {
          audit: true, action: "user.update", user: user.username, role: user.role,
          password: password !== undefined,
          // The connection ID is not a secret (the token is, and it stays in the vault).
          git: githubConnectionId !== undefined || gitName !== undefined || gitEmail !== undefined,
        },
        "user updated",
      );
      return await reply.send({ user, git: git ?? undefined });
    } catch (err) {
      const message = (err as Error).message;
      return await reply.code(/not found/i.test(message) ? 404 : 400).send({ error: message });
    }
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd back && npx vitest run src/routes/users.test.ts`
Expected: PASS, incluindo os testes que já existiam

- [ ] **Step 5: Commit**

```bash
git add back/src/routes/users.ts back/src/routes/users.test.ts
git commit -m "feat(identidade): owner vincula conexão GitHub e autor do commit ao usuário"
```

---

### Task 3: Resolução da identidade em vigor

**Files:**
- Create: `back/src/services/github/identity.ts`
- Test: `back/src/services/github/identity.test.ts`

**Interfaces:**
- Consumes: `UserGitIdentity` (Tarefa 1); `GithubConnection`/`Project` de `registry.js`;
  `GitIdentitySettings` de `settings.js`.
- Produces:
  - `interface EffectiveIdentity { connectionId?: string; name: string; email: string }`
  - `resolveIdentity(opts: { actor?: UserGitIdentity | null; project: Pick<Project, "githubConnectionId">; settings: Pick<Settings, "git">; connections: Pick<GithubConnection, "id">[] }): EffectiveIdentity`

- [ ] **Step 1: Write the failing test**

`back/src/services/github/identity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveIdentity } from "./identity.js";

const settings = { git: { name: "César Canal", email: "cesarvcanal@gmail.com" } };
const connections = [{ id: "c-cesar" }, { id: "c-mussa" }];
const project = { githubConnectionId: "c-cesar" };

describe("identidade em vigor", () => {
  it("sem ator, vale o projeto e a instalação", () => {
    expect(resolveIdentity({ project, settings, connections })).toEqual({
      connectionId: "c-cesar", name: "César Canal", email: "cesarvcanal@gmail.com",
    });
  });

  it("ator completo ganha do projeto nos três campos", () => {
    const actor = { userId: "u2", githubConnectionId: "c-mussa", gitName: "wellesley-mussolini", gitEmail: "xerif.off@gmail.com" };
    expect(resolveIdentity({ actor, project, settings, connections })).toEqual({
      connectionId: "c-mussa", name: "wellesley-mussolini", email: "xerif.off@gmail.com",
    });
  });

  it("a resolução é campo por campo: ator só com conexão mantém o autor da instalação", () => {
    const actor = { userId: "u2", githubConnectionId: "c-mussa" };
    expect(resolveIdentity({ actor, project, settings, connections })).toEqual({
      connectionId: "c-mussa", name: "César Canal", email: "cesarvcanal@gmail.com",
    });
  });

  it("ator só com autor mantém a conexão do projeto", () => {
    const actor = { userId: "u2", gitName: "wellesley-mussolini", gitEmail: "xerif.off@gmail.com" };
    expect(resolveIdentity({ actor, project, settings, connections })).toEqual({
      connectionId: "c-cesar", name: "wellesley-mussolini", email: "xerif.off@gmail.com",
    });
  });

  it("conexão do ator que não existe mais cai na do projeto, não quebra o push", () => {
    const actor = { userId: "u2", githubConnectionId: "apagada" };
    expect(resolveIdentity({ actor, project, settings, connections }).connectionId).toBe("c-cesar");
  });

  it("ator removido do vibehub (null) se comporta como ausente", () => {
    expect(resolveIdentity({ actor: null, project, settings, connections }).connectionId).toBe("c-cesar");
  });

  it("projeto sem conexão e ator sem conexão: a primeira da lista, igual ao clone", () => {
    expect(resolveIdentity({ project: {}, settings, connections }).connectionId).toBe("c-cesar");
  });

  it("instalação sem nenhuma conexão: sem conexão nenhuma, nunca inventada", () => {
    expect(resolveIdentity({ project: {}, settings, connections: [] }).connectionId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back && npx vitest run src/services/github/identity.test.ts`
Expected: FAIL — `Cannot find module './identity.js'`

- [ ] **Step 3: Write minimal implementation**

`back/src/services/github/identity.ts`:

```ts
import type { UserGitIdentity } from "../../auth/userGit.js";
import type { GithubConnection, Project } from "../board/registry.js";
import type { Settings } from "../settings/settings.js";

/**
 * WHOSE identity a card operates with, resolved FIELD BY FIELD — not "the first complete object".
 * A person who registered only a connection keeps the install's commit author, and a person who
 * registered only a name keeps the project's connection; treating the identity as one indivisible
 * record would silently drop half of what the owner configured.
 *
 * Order per field: the card's ACTOR (whoever touched it last) → the PROJECT → the INSTALL.
 *
 * The actor's connection is only honoured when it still EXISTS. An id left behind by a connection
 * the owner removed falls through to the project, because the alternative is every push of that
 * person failing with a credential that is not in the vault.
 *
 * PURE — no vault, no GitHub, no disk. The token is fetched by the caller from `connectionId`.
 */
export interface EffectiveIdentity {
  /** GitHub connection whose token to use. Absent = this install has no GitHub account at all. */
  connectionId?: string;
  name: string;
  email: string;
}

export function resolveIdentity(opts: {
  actor?: UserGitIdentity | null;
  project: Pick<Project, "githubConnectionId">;
  settings: Pick<Settings, "git">;
  connections: Pick<GithubConnection, "id">[];
}): EffectiveIdentity {
  const { actor, project, settings, connections } = opts;
  const exists = (id?: string | null): boolean => !!id && connections.some((c) => c.id === id);
  const connectionId =
    (exists(actor?.githubConnectionId) ? actor?.githubConnectionId : undefined) ??
    (exists(project?.githubConnectionId) ? project?.githubConnectionId : undefined) ??
    connections[0]?.id;
  return {
    connectionId,
    name: actor?.gitName ?? settings.git.name,
    email: actor?.gitEmail ?? settings.git.email,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd back && npx vitest run src/services/github/identity.test.ts`
Expected: PASS (8 testes)

- [ ] **Step 5: Commit**

```bash
git add back/src/services/github/identity.ts back/src/services/github/identity.test.ts
git commit -m "feat(identidade): resolução campo por campo (ator, projeto, instalação)"
```

---

### Task 4: Ator do card

**Files:**
- Modify: `back/src/services/board/registry.ts` (interface `Card`, + `stampCardActor`)
- Modify: `back/src/routes/session.ts:214` (`POST /api/cards/:id/open`), `:334`
  (`POST /api/cards/:id/messages`), `:430` (websocket `/api/cards/:id/terminal`)
- Modify: `back/src/routes/cardSdk.ts:62` (websocket `/api/cards/:id/sdk`)
- Test: `back/src/services/board/registry.test.ts`, `back/src/routes/session.test.ts`

**Interfaces:**
- Consumes: `cardLevel` de `back/src/auth/access.js`, `sessionUserId` de `back/src/auth/session.js`.
- Produces:
  - `Card.actorUserId?: string`, `Card.actorAt?: number`
  - `stampCardActor(cardId: string, userId: string): Promise<{ changed: boolean; card: Card } | null>`

- [ ] **Step 1: Write the failing test**

Em `back/src/services/board/registry.test.ts`:

```ts
it("estampa o ator do card e diz quando ele MUDOU", async () => {
  const project = await registry.createProject({ name: "p" });
  const card = await registry.createCard({ projectId: project.id, title: "c" });

  const first = await registry.stampCardActor(card.id, "u-cesar");
  expect(first?.changed).toBe(true);
  expect(first?.card.actorUserId).toBe("u-cesar");

  // Mesmo ator de novo: nada mudou, e nada precisa ser reaplicado no runner.
  const again = await registry.stampCardActor(card.id, "u-cesar");
  expect(again?.changed).toBe(false);

  const switched = await registry.stampCardActor(card.id, "u-mussa");
  expect(switched?.changed).toBe(true);
  expect(switched?.card.actorUserId).toBe("u-mussa");
});

it("card que não existe não estoura, devolve null", async () => {
  expect(await registry.stampCardActor("nao-existe", "u1")).toBeNull();
});
```

Em `back/src/routes/session.test.ts` (reusando o boot/login que o arquivo já tem):

```ts
it("mandar prompt estampa o ator, e acesso view NÃO estampa", async () => {
  const owner = await signInAsOwner();
  const { projectId, cardId } = await seedCard();
  const mussaId = await createMember("mussa", "Multi@102030");

  // Compartilhado como VIEW: pode ler, não pode trabalhar — logo não pode virar autor do commit.
  await app.inject({
    method: "POST", url: `/api/cards/${cardId}/shares`, headers: { cookie: owner },
    payload: { userId: mussaId, level: "view" },
  });
  const mussa = await signIn("mussa", "Multi@102030");
  const denied = await app.inject({
    method: "POST", url: `/api/cards/${cardId}/messages`, headers: { cookie: mussa }, payload: { text: "oi" },
  });
  expect(denied.statusCode).toBe(403);
  const registry = await import("../services/board/registry.js");
  expect((await registry.getCard(cardId))?.actorUserId).toBeUndefined();

  // Promovido a WORK: agora o envio estampa.
  await app.inject({
    method: "POST", url: `/api/cards/${cardId}/shares`, headers: { cookie: owner },
    payload: { userId: mussaId, level: "work" },
  });
  await app.inject({
    method: "POST", url: `/api/cards/${cardId}/messages`, headers: { cookie: mussa }, payload: { text: "oi" },
  });
  expect((await registry.getCard(cardId))?.actorUserId).toBe(mussaId);
  expect(projectId).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back && npx vitest run src/services/board/registry.test.ts src/routes/session.test.ts`
Expected: FAIL — `stampCardActor is not a function`

- [ ] **Step 3: Write minimal implementation**

Em `back/src/services/board/registry.ts`, acrescente à interface `Card` (junto dos outros campos
opcionais de estado):

```ts
  /**
   * WHO touched this card last — the person whose git identity its commits and pushes use. Stamped
   * by opening it, attaching the terminal, or sending a prompt; `view` access never stamps, because
   * somebody who cannot work the card must not become the author of its commits.
   */
  actorUserId?: string;
  actorAt?: number;
```

E a função (perto de `updateCard`):

```ts
/**
 * Records who is working the card NOW. Returns `changed: false` when the actor is the same as
 * before, so the caller can skip reapplying the identity in the runner — this is called on every
 * websocket attach and every prompt, and a write per frame would be pure noise.
 * Null = no such card (a deleted card must not make an attach throw).
 */
export async function stampCardActor(cardId: string, userId: string): Promise<{ changed: boolean; card: Card } | null> {
  const id = String(cardId ?? "");
  const user = String(userId ?? "");
  if (!id || !user) return null;
  return await store.mutate((doc) => {
    const card = doc.cards.find((c) => c.id === id);
    if (!card) return null;
    if (card.actorUserId === user) return { changed: false, card: { ...card } };
    card.actorUserId = user;
    card.actorAt = Date.now();
    return { changed: true, card: { ...card } };
  });
}
```

Nos quatro pontos, estampe logo após o preHandler ter aprovado. `requireCardWork` já garante nível
`work`, então o `view` é barrado antes de chegar aqui — é disso que o teste negativo vive.

`back/src/routes/session.ts`, no `POST /api/cards/:id/open`:

```ts
const by = (await sessionUserId(req)) ?? undefined;
if (by) await registry.stampCardActor(req.params.id, by);
```

No `POST /api/cards/:id/messages`, antes do `outbox.queueMessage`:

```ts
const by = (await sessionUserId(req)) ?? undefined;
if (by) await registry.stampCardActor(req.params.id, by);
```

No websocket `/api/cards/:id/terminal` e no `/api/cards/:id/sdk`, logo na abertura do socket:

```ts
const by = (await sessionUserId(req)) ?? undefined;
if (by) await registry.stampCardActor(req.params.id, by);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd back && npx vitest run src/services/board/registry.test.ts src/routes/session.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add back/src/services/board/registry.ts back/src/routes/session.ts back/src/routes/cardSdk.ts back/src/services/board/registry.test.ts back/src/routes/session.test.ts
git commit -m "feat(identidade): o card registra quem mexeu por último"
```

---

### Task 5: Aplicar a identidade no runner (ler na hora, não no boot)

**Files:**
- Modify: `back/src/services/board/workspace.ts` (`buildOpenScript`, + `buildIdentityScript`)
- Modify: `back/src/runtime/runner.ts:185-187` (o shim do `gh` no setup)
- Test: `back/src/services/board/workspace.test.ts`

**Interfaces:**
- Consumes: `EffectiveIdentity` (Tarefa 3); `ghTokenPath`, `writeGhTokenLines`, `removeGhTokenLines`
  de `back/src/services/accounts/token.js`; `shQuote`, `assertSafeRemotePath` de `back/src/runtime/host.js`.
- Produces: `buildIdentityScript(opts: { containerName: string; cardId: string; cwd: string; identity: EffectiveIdentity; token?: string }): string`

- [ ] **Step 1: Write the failing test**

Em `back/src/services/board/workspace.test.ts`:

```ts
import { buildIdentityScript } from "./workspace.js";

describe("aplicar identidade na worktree", () => {
  const base = {
    containerName: "vibehub-runner", cardId: "card-1", cwd: "/work/p/c",
    identity: { connectionId: "c-mussa", name: "wellesley-mussolini", email: "xerif.off@gmail.com" },
  };

  it("grava autor do commit NA WORKTREE, não global", () => {
    const s = buildIdentityScript(base);
    expect(s).toContain("git -C '/work/p/c' config --local user.name 'wellesley-mussolini'");
    expect(s).toContain("git -C '/work/p/c' config --local user.email 'xerif.off@gmail.com'");
    expect(s).not.toContain("--global");
  });

  it("ZERA a lista de helpers antes de instalar o que lê o arquivo do card", () => {
    const s = buildIdentityScript(base);
    const reset = s.indexOf("credential.helper ''");
    const install = s.indexOf("/root/.vibehub/gh/card-1.token");
    // Sem o reset primeiro, o `gh auth git-credential` global responde antes com o token do boot.
    expect(reset).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(reset);
  });

  it("com token, escreve o arquivo do card; sem token, REMOVE (nada obsoleto sobra)", () => {
    expect(buildIdentityScript({ ...base, token: "ghp_abcdefghijklmnopqrstuvwxyz" }))
      .toContain("> '/root/.vibehub/gh/card-1.token'");
    expect(buildIdentityScript(base)).toContain("rm -f '/root/.vibehub/gh/card-1.token'");
  });

  it("nome com caractere de shell nunca chega cru ao script", () => {
    expect(() => buildIdentityScript({ ...base, identity: { ...base.identity, name: "x'; rm -rf /" } })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back && npx vitest run src/services/board/workspace.test.ts`
Expected: FAIL — `buildIdentityScript is not exported`

- [ ] **Step 3: Write minimal implementation**

Em `back/src/services/board/workspace.ts`:

```ts
import { assertGitName, assertGitEmail } from "../../auth/userGit.js";
import type { EffectiveIdentity } from "../github/identity.js";

/**
 * Applies an identity to a card's worktree — the whole reason the actor can CHANGE mid-card.
 *
 * `GH_TOKEN` is exported ONCE, when the tmux session is born (see sessionCommand). Rewriting the
 * card's token file therefore does NOT change the variable a live session already exported: the
 * actor would switch on the board and the push would still go out as the previous person, silently.
 * So nothing here relies on session env. Both halves are read AT CALL TIME:
 *
 *  - the commit author is `--local` config in the worktree; git reads it when the commit happens.
 *  - the credential helper CATS the card's token file on every git call. The helper list is RESET
 *    first (`credential.helper ''`): git consults system -> global -> local in order and uses the
 *    first helper that answers, and the global `gh auth git-credential` would answer with the stale
 *    `GH_TOKEN` from the boot.
 *
 * `gh` itself (a `gh pr create` typed in a live terminal) is handled by the shim planted in
 * /root/.bashrc by the runner setup, which re-exports GH_TOKEN from this same file before delegating.
 *
 * Name and e-mail are RE-VALIDATED here even though the route validated them: they are interpolated
 * into bash, and this is the last gate before that. PURE.
 */
export function buildIdentityScript(opts: {
  containerName: string; cardId: string; cwd: string; identity: EffectiveIdentity; token?: string;
}): string {
  const { containerName, cardId, cwd, identity, token } = opts;
  assertSafeRemotePath(cwd);
  const name = assertGitName(identity.name);
  const email = assertGitEmail(identity.email);
  const file = ghTokenPath(cardId);
  const body = [
    "set -e",
    "umask 077",
    ...(token ? writeGhTokenLines(cardId, token) : removeGhTokenLines(cardId)),
    `git -C ${shQuote(cwd)} config --local user.name ${shQuote(name)}`,
    `git -C ${shQuote(cwd)} config --local user.email ${shQuote(email)}`,
    // Reset FIRST, then install ours: see the note above about helper order.
    `git -C ${shQuote(cwd)} config --local credential.helper ''`,
    `git -C ${shQuote(cwd)} config --local --add credential.helper ` +
      shQuote(`!f() { [ -s ${file} ] && echo "username=x-access-token" && echo "password=$(cat ${file})"; }; f`),
  ];
  const DELIM = "VIBEHUB_IDENTITY";
  return ["set -e", `docker exec -i ${shQuote(containerName)} bash -s <<'${DELIM}'`, ...body, DELIM].join("\n");
}
```

Em `back/src/runtime/runner.ts`, no `buildSetupScript`, logo depois das duas linhas de
`git config --global user.*` (que **permanecem** — são o fallback da instalação), plante o shim:

```ts
    // `gh` shim: a live terminal exported GH_TOKEN when the session was born, so a later actor
    // switch would not reach `gh pr create`. Re-export from the card's token file at call time.
    "grep -q VIBEHUB_GH_SHIM /root/.bashrc 2>/dev/null || cat >> /root/.bashrc <<'VIBEHUB_GH_SHIM'",
    "gh() { if [ -n \"$VIBEHUB_CARD_ID\" ] && [ -s \"/root/.vibehub/gh/$VIBEHUB_CARD_ID.token\" ]; then GH_TOKEN=\"$(cat /root/.vibehub/gh/$VIBEHUB_CARD_ID.token)\" command gh \"$@\"; else command gh \"$@\"; fi; }",
    "VIBEHUB_GH_SHIM",
```

Chame `buildIdentityScript` em dois lugares:

1. em `provisionWorkspace` (`workspace.ts:~625`), trocando a resolução fixa do token:

```ts
    // The identity in force for this card: the ACTOR's, falling back to the project's and the
    // install's (see services/github/identity.ts). Replaces the old fixed
    // `tokenFor(project.githubConnectionId)` — same result when the card has no actor.
    const actor = card.actorUserId ? await getUserGit(card.actorUserId) : null;
    const identity = resolveIdentity({
      actor, project, settings: await getSettings(), connections: await listGithubConnections(),
    });
    let ghToken: string | undefined;
    try {
      if (identity.connectionId) ghToken = await tokenFor(identity.connectionId);
    } catch (e) {
      logger.warn({ card: card.worktreeSlug, detail: (e as Error).message }, "GitHub connection token not resolved on open (ambient gh login)");
    }
```

   e, depois do `runScript(script)` do open, aplique a identidade (a worktree já existe aqui):

```ts
    await hostExecutor().runScript(
      buildIdentityScript({ containerName: config.runner.container, cardId: card.id, cwd: paths.cwd, identity, token: ghToken }),
      { timeoutMs: 30_000 },
    );
```

2. em `stampCardActor`, quando `changed === true`: a troca de ator num card já aberto. Faça isso no
   serviço, não na rota — as quatro rotas chamam o mesmo caminho. Acrescente em `workspace.ts`:

```ts
/**
 * Re-applies the card's identity after the ACTOR changed on an OPEN card. Best-effort by design: a
 * runner that is down must not make a prompt fail — the next open re-applies it anyway.
 */
export async function reapplyCardIdentity(cardId: string): Promise<void> {
  const card = await getCard(cardId);
  if (!card || !card.openedAt) return;
  const project = await getProject(card.projectId);
  if (!project) return;
  const { cwd } = cardWorkPaths(project, card);
  const actor = card.actorUserId ? await getUserGit(card.actorUserId) : null;
  const identity = resolveIdentity({
    actor, project, settings: await getSettings(), connections: await listGithubConnections(),
  });
  let token: string | undefined;
  try {
    if (identity.connectionId) token = await tokenFor(identity.connectionId);
  } catch { /* no connection → ambient login, same as the open path */ }
  try {
    await hostExecutor().runScript(
      buildIdentityScript({ containerName: config.runner.container, cardId: card.id, cwd, identity, token }),
      { timeoutMs: 30_000 },
    );
  } catch (e) {
    logger.warn({ card: card.worktreeSlug, detail: (e as Error).message }, "card identity not reapplied (runner unreachable)");
  }
}
```

   e nas quatro rotas, troque `if (by) await registry.stampCardActor(...)` por:

```ts
      if (by) {
        const stamped = await registry.stampCardActor(req.params.id, by);
        if (stamped?.changed) void workspace.reapplyCardIdentity(req.params.id);
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd back && npx vitest run src/services/board/workspace.test.ts && npx tsc -b`
Expected: PASS e typecheck limpo

- [ ] **Step 5: Commit**

```bash
git add back/src/services/board/workspace.ts back/src/runtime/runner.ts back/src/services/board/workspace.test.ts back/src/routes/session.ts back/src/routes/cardSdk.ts
git commit -m "feat(identidade): autor e credencial lidos na hora, não no boot da sessão"
```

---

### Task 6: `deliver` empurra como o ator

**Files:**
- Modify: `back/src/services/maestro/deliver.ts` (a resolução do token)
- Test: `back/src/services/maestro/deliver.test.ts`

**Interfaces:**
- Consumes: `resolveIdentity` (Tarefa 3), `getUserGit` (Tarefa 1), `tokenFor`, `listGithubConnections`.
- Produces: nada novo — muda de onde o `deliver` tira o token.

- [ ] **Step 1: Write the failing test**

Em `back/src/services/maestro/deliver.test.ts`:

```ts
it("o PR sai na conta do ATOR do card, não na do projeto", async () => {
  // projeto aponta pra c-cesar; o card tem o mussa como ator, cuja conexão é c-mussa
  const { tokenFor } = await import("../github/client.js");
  await deliverCard(cardId, { branch: "dev" });
  expect(vi.mocked(tokenFor)).toHaveBeenCalledWith("c-mussa");
});

it("card sem ator mantém o comportamento de hoje: a conexão do projeto", async () => {
  const { tokenFor } = await import("../github/client.js");
  await deliverCard(cardSemAtorId, { branch: "dev" });
  expect(vi.mocked(tokenFor)).toHaveBeenCalledWith("c-cesar");
});
```

Use o mock de `hostExecutor`/`tokenFor` que o arquivo já monta; se ele ainda não existir,
espelhe o de `back/src/services/board/workspace.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back && npx vitest run src/services/maestro/deliver.test.ts`
Expected: FAIL — `tokenFor` chamado com `"c-cesar"` no primeiro teste

- [ ] **Step 3: Write minimal implementation**

Em `deliver.ts`, troque `await tokenFor(project.githubConnectionId)` por:

```ts
  // The identity in force for the card (actor -> project -> install), the SAME resolution the open
  // uses. A merge is a deploy: it must be attributed to whoever is actually driving the card.
  const actor = card.actorUserId ? await getUserGit(card.actorUserId) : null;
  const identity = resolveIdentity({
    actor, project, settings: await getSettings(), connections: await listGithubConnections(),
  });
  const token = await tokenFor(identity.connectionId);
```

E atualize o comentário de cabeçalho do arquivo: não é mais "as the PROJECT's GitHub connection", é
"as the card's ACTOR, falling back to the project's connection".

- [ ] **Step 4: Run test to verify it passes**

Run: `cd back && npx vitest run src/services/maestro/deliver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add back/src/services/maestro/deliver.ts back/src/services/maestro/deliver.test.ts
git commit -m "feat(identidade): deliver abre e mergeia o PR na conta do ator do card"
```

---

### Task 7: Tela — vincular identidade na lista de usuários

**Files:**
- Modify: `front/src/features/settings/AccessDialog.tsx` (a lista de usuários do owner)
- Modify: `front/src/api/types.ts` (o tipo do usuário), `front/src/i18n/pt-BR.ts`, `front/src/i18n/en.ts`
- Test: `front/src/features/settings/AccessDialog.test.tsx`

**Interfaces:**
- Consumes: `PATCH /api/users/:id` com `githubConnectionId`/`gitName`/`gitEmail` (Tarefa 2);
  `GET /api/github` pra listar as conexões.
- Produces: nada que outra tarefa consuma.

- [ ] **Step 1: Write the failing test**

Em `front/src/features/settings/AccessDialog.test.tsx`:

O arquivo NÃO usa msw: ele mocka `@/lib/api` com `vi.fn()` e tem o helper `serve(me, users)` que
responde ao `get` por url. Estenda o `serve` pra responder `/github` e acrescente o teste:

```ts
it("o owner escolhe a conexão GitHub e o autor do commit de um membro", async () => {
  // `serve` precisa de um caso novo: if (url === "/github") return { connections };
  serve(OWNER, [OWNER, MEMBER], [], {}, [
    { id: "c-mussa", label: "mussa", login: "wellesley-mussolini", ok: true },
  ]);
  patch.mockResolvedValue({ user: MEMBER });
  renderApp(<AccessDialog open onOpenChange={() => {}} />);

  await userEvent.selectOptions(await screen.findByTestId("user-git-connection-u2"), "c-mussa");
  await userEvent.type(screen.getByTestId("user-git-name-u2"), "wellesley-mussolini");
  await userEvent.type(screen.getByTestId("user-git-email-u2"), "xerif.off@gmail.com");
  await userEvent.click(screen.getByTestId("user-git-save-u2"));

  await waitFor(() => expect(patch).toHaveBeenCalledWith("/users/u2", {
    githubConnectionId: "c-mussa", gitName: "wellesley-mussolini", gitEmail: "xerif.off@gmail.com",
  }));
});

it("um membro não vê o bloco de identidade de ninguém", async () => {
  serve(MEMBER, [OWNER, MEMBER]);
  renderApp(<AccessDialog open onOpenChange={() => {}} />);
  await screen.findByText(/senha/i);
  expect(screen.queryByTestId("user-git-connection-u2")).toBeNull();
});
```

A assinatura do `renderApp(<AccessDialog .../>)` deve copiar a que os testes vizinhos do arquivo já
usam — não invente props.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd front && npx vitest run src/features/settings/AccessDialog.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-testid="user-git-connection-u2"]`

- [ ] **Step 3: Write minimal implementation**

Na linha de cada usuário do `AccessDialog`, acrescente um bloco "GitHub" com três controles e um
botão de salvar, só visível pro owner (o diálogo já é owner-only). Siga o componente de select e de
input que o arquivo já usa — não introduza componente novo. O `onSave` manda só os campos
preenchidos:

O dialog já usa react-query + os helpers `get`/`patch` de `@/lib/api`, e as urls são SEM o prefixo
`/api` (`"/users"`, não `"/api/users"`). Reuse a mutation `update` que já existe ali, ampliando o
corpo dela:

```tsx
const update = useMutation({
  mutationFn: ({ id, ...body }: {
    id: string; password?: string; role?: Role;
    githubConnectionId?: string | null; gitName?: string | null; gitEmail?: string | null;
  }) => patch<{ user: User }>(`/users/${encodeURIComponent(id)}`, body),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
});

const connections = useQuery({
  queryKey: ["github"] as const,
  queryFn: () => get<{ connections: GithubConnectionView[] }>("/github").then((r) => r.connections),
  enabled: isOwner,
});
```

e o botão de salvar chama `update.mutate({ id: u.id, githubConnectionId: draft.connectionId || null,
gitName: draft.name || null, gitEmail: draft.email || null })`. O bloco inteiro fica atrás de
`isOwner` — o membro continua vendo só a própria senha, como o comentário do arquivo (linha 27) diz.

Textos novos em `pt-BR.ts` e `en.ts` (o teste de i18n do repo cobre chave faltando nos dois):
`access.gitSection` ("Identidade no GitHub" / "GitHub identity"),
`access.gitConnection` ("Conta do GitHub" / "GitHub account"),
`access.gitName` ("Nome no commit" / "Commit name"),
`access.gitEmail` ("E-mail no commit" / "Commit e-mail"),
`access.gitHint` ("Vazio = usa a conta do projeto e o autor da instalação" /
"Empty = the project's account and the install's author").

- [ ] **Step 4: Run test to verify it passes**

Run: `cd front && npx vitest run src/features/settings/AccessDialog.test.tsx src/i18n && npx tsc -b`
Expected: PASS e typecheck limpo

- [ ] **Step 5: Commit**

```bash
git add front/src/features/settings/AccessDialog.tsx front/src/features/settings/AccessDialog.test.tsx front/src/api/types.ts front/src/i18n/pt-BR.ts front/src/i18n/en.ts
git commit -m "feat(identidade): vínculo de conta GitHub e autor do commit na tela de usuários"
```

---

### Task 8: Documentação e suíte inteira

**Files:**
- Modify: `docs/ARCHITECTURE.md` (a seção de credencial/GitHub), `docs/API.md` (`PATCH /api/users/:id`)

- [ ] **Step 1: Rodar a suíte inteira dos dois pacotes**

Run: `cd back && npx vitest run && npx tsc -b && cd ../front && npx vitest run && npx tsc -b`
Expected: tudo verde. Qualquer teste que já existia e passou a falhar é regressão — conserte antes
de seguir, não ajuste o teste.

- [ ] **Step 2: Documentar**

Em `docs/API.md`, no `PATCH /api/users/:id`, documente os três campos novos e que `null` limpa.
Em `docs/ARCHITECTURE.md`, na parte que explica a credencial do card, registre a ordem
ator → projeto → instalação e **por que** a leitura é na hora e não no boot da sessão (o `GH_TOKEN`
exportado uma vez no nascimento do tmux).

- [ ] **Step 3: Commit**

```bash
git add docs/API.md docs/ARCHITECTURE.md
git commit -m "docs: identidade por usuário na API e na arquitetura"
```

---

## Depois do plano (operacional, não é código)

1. O Mussa cola o PAT da conta `wellesley-mussolini` na tela de GitHub, label `mussa`.
2. O César cria o usuário `mussa` com a senha `Multi@102030` e, na linha dele, escolhe a conexão
   `mussa`, nome `wellesley-mussolini`, e-mail `xerif.off@gmail.com`.
3. Conferir num card real: abrir um card do César, mandar um prompt como `mussa`, pedir um commit, e
   checar `git log -1 --format='%an <%ae>'` na worktree.
