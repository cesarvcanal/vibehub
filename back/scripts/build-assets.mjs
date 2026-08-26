// Copies the non-TS assets `tsc` leaves behind into `dist`, so `node dist/index.js` finds them at
// the same relative path the source resolves in dev and in tests. Today that is the maestro persona
// (`services/brain/personas/*.md`), read by the MCP server as its `instructions` (see mcp/server.ts).
//
// Node built-ins only — it runs in the very toolchain that just ran `tsc`, so it needs nothing
// installed. Idempotent: it recreates the destination tree and overwrites in place.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const backRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rel = join("services", "brain", "personas");
const src = join(backRoot, "src", rel);
const dest = join(backRoot, "dist", rel);

mkdirSync(dest, { recursive: true });
// Only the markdown assets — any future `.ts` in this dir is already compiled into dist by tsc.
cpSync(src, dest, { recursive: true, filter: (p) => !p.endsWith(".ts") });

// The SDK driver script (`services/sdk/sdk-driver.mjs`) — read at runtime by services/sdk/driver.ts
// and planted into the runner. tsc ignores .mjs, so copy the file to the same relative path in dist.
const sdkRel = join("services", "sdk");
const sdkDest = join(backRoot, "dist", sdkRel);
mkdirSync(sdkDest, { recursive: true });
cpSync(join(backRoot, "src", sdkRel, "sdk-driver.mjs"), join(sdkDest, "sdk-driver.mjs"));
