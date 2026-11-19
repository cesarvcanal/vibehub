# Contributing

Thanks for taking a look.

## Ground rules

- **Tests come first.** Write the test, watch it fail for the right reason, then implement
  (Vitest, co-located as `*.test.ts`). A bug fix includes the test that reproduces it.
- **Anything that reaches a shell gets validated at the boundary**, and quoted after that. Card
  ids, branch names, session ids and container names all end up in a `docker exec` line. Read
  `back/src/runtime/host.ts` before writing code that builds one.
- **Secrets travel over stdin, never argv.** `ps` is world-readable.
- **Code explains itself; the why lives in the commit and the PR.** New lines carry no comments
  beyond a short list of exceptions (external rule, technical limitation, tool directive, legacy
  name). A non-obvious invariant gets a test whose name states the rule. Existing comments stay —
  many are scars from production bugs — unless your change makes them false.
- **`const` for everything you write.** `let` only for live state that a process, session or
  stream reassigns over its lifetime.
- **Performance is a requirement.** Every `docker exec`, state read, websocket event and render is
  shared by every card on the runner; do the least real work that covers the case.

## Layout

```
back/src/
  config/    environment
  runtime/   host executor (local docker | ssh) and runner lifecycle
  secrets/   encrypted local vault
  store/     atomic JSON persistence
  auth/      local accounts and cookie sessions
  services/  board, accounts, mcp, brain, import, browser, github, settings
  routes/    HTTP + websocket surface
front/src/
  features/  board, terminal, setup wizard, settings
  components/ui  primitives
```

## Running it

```bash
npm run install:all
npm --prefix back run dev
npm --prefix front run dev
npm test
npm run lint:changed   # the AGENTS.md rules a machine can check, on the lines your branch adds
```

You need Docker locally to exercise the runner paths end to end; the unit tests mock the host
executor and run without it.

## Pull requests

One logical change per PR, please. Describe what breaks if the change is wrong — that is the part
reviewers cannot reconstruct. Commit messages follow [Gitmoji](https://gitmoji.dev)
(`🐛 fix(area): ...`) and explain why; the full rules, PR template included, are in
[`AGENTS.md`](AGENTS.md) §14.
