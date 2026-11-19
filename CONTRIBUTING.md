# Contributing

Thanks for taking a look.

## Rules

The rules for code, tests, commits and pull requests live in one place: [`AGENTS.md`](AGENTS.md).
This file only points there. `npm run lint:changed` checks the part a machine can check, on the
lines your branch adds; the rest is on you and on review.

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

Commits, PR description and review follow [`AGENTS.md`](AGENTS.md) §14.
