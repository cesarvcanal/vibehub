# Contributing

Thanks for taking a look.

## Ground rules

- **Tests come with the change.** Vitest, co-located as `*.test.ts`. A bug fix should include the
  test that fails without it.
- **Anything that reaches a shell gets validated at the boundary**, and quoted after that. Card
  ids, branch names, session ids and container names all end up in a `docker exec` line. Read
  `back/src/runtime/host.ts` before writing code that builds one.
- **Secrets travel over stdin, never argv.** `ps` is world-readable.
- **Comments explain why, not what.** Several of the strange-looking lines in this repo are scars
  from production bugs; if you fix one, leave the story behind.

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
```

You need Docker locally to exercise the runner paths end to end; the unit tests mock the host
executor and run without it.

## Pull requests

One logical change per PR, please. Describe what breaks if the change is wrong — that is the part
reviewers cannot reconstruct.
