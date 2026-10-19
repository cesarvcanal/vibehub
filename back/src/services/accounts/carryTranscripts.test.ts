import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, readFile, writeFile, utimes, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryTranscriptsCommand, PROFILE_ROOTS } from "./carryTranscripts.js";
import { claudeProjectsDirName } from "../import/import.js";

/**
 * The card's conversation follows it across an account switch. Like the first-run seed, the command
 * is RUN FOR REAL in bash over temp profiles: the bug was a transcript in the wrong directory, so
 * only the files on disk prove it.
 */

let dir = "";
let roots: string[] = [];
let cwd = "";
const SESSION = "7f0ce176-edd7-4251-a73a-77ed1efe59e7";

const profile = (name: string) => join(dir, "profiles", name);
const transcriptDir = (p: string, at = cwd) => join(p, "projects", claudeProjectsDirName(at));
const transcript = (p: string, at = cwd) => join(transcriptDir(p, at), `${SESSION}.jsonl`);

function carry(into: string, at = cwd): void {
  execFileSync("bash", ["-c", carryTranscriptsCommand(into, '"$PWD"', roots)], { cwd: at });
}

async function writeTranscript(p: string, body: string, mtime: Date, at = cwd): Promise<void> {
  await mkdir(transcriptDir(p, at), { recursive: true });
  await writeFile(transcript(p, at), body);
  await utimes(transcript(p, at), mtime, mtime);
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vibehub-carry-")));
  roots = [join(dir, "default"), `${join(dir, "profiles")}/*`];
  cwd = join(dir, "work", "repo-worktrees", "card-a");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(dir, "profiles"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("carryTranscriptsCommand", () => {
  it("brings the card's session from the previous account into the new one (the --resume bug)", async () => {
    await writeTranscript(profile("cesar"), "turn-1\n", new Date("2026-10-19T10:00:00Z"));
    await mkdir(join(transcriptDir(profile("cesar")), SESSION, "subagents"), { recursive: true });
    await writeFile(join(transcriptDir(profile("cesar")), SESSION, "subagents", "a.jsonl"), "sub\n");
    await mkdir(profile("albert"), { recursive: true });

    carry(profile("albert"));

    expect(await readFile(transcript(profile("albert")), "utf8")).toBe("turn-1\n");
    expect(await readFile(join(transcriptDir(profile("albert")), SESSION, "subagents", "a.jsonl"), "utf8")).toBe("sub\n");
    // The source is left as it was.
    expect(await readFile(transcript(profile("cesar")), "utf8")).toBe("turn-1\n");
  });

  it("also carries from and into the default profile", async () => {
    await writeTranscript(join(dir, "default"), "from-default\n", new Date("2026-10-19T10:00:00Z"));
    carry(profile("albert"));
    expect(await readFile(transcript(profile("albert")), "utf8")).toBe("from-default\n");

    await writeTranscript(profile("albert"), "from-default\nmore\n", new Date("2026-10-19T11:00:00Z"));
    carry(join(dir, "default"));
    expect(await readFile(transcript(join(dir, "default")), "utf8")).toBe("from-default\nmore\n");
  });

  it("switching back keeps the NEWEST copy (A → B → A does not resume A's stale transcript)", async () => {
    await writeTranscript(profile("cesar"), "turn-1\n", new Date("2026-10-19T10:00:00Z"));
    await writeTranscript(profile("albert"), "turn-1\nturn-2\n", new Date("2026-10-19T11:00:00Z"));

    carry(profile("cesar"));
    expect(await readFile(transcript(profile("cesar")), "utf8")).toBe("turn-1\nturn-2\n");

    // And the other way round, the newer target is never overwritten by an older source.
    carry(profile("albert"));
    expect(await readFile(transcript(profile("albert")), "utf8")).toBe("turn-1\nturn-2\n");
  });

  it("only touches THIS card's cwd — other cards and the rest of the profile stay put", async () => {
    const other = join(dir, "work", "repo-worktrees", "card-b");
    await mkdir(other, { recursive: true });
    await writeTranscript(profile("cesar"), "other card\n", new Date("2026-10-19T10:00:00Z"), other);
    await writeFile(join(profile("cesar"), ".oauth-token"), "secret");
    await mkdir(profile("albert"), { recursive: true });

    carry(profile("albert"));

    expect(await readdir(profile("albert"))).toEqual([]);
  });

  it("is a no-op, and never fails, when no profile holds anything", async () => {
    expect(() => carry(profile("albert"))).not.toThrow();
    roots = [join(dir, "missing"), `${join(dir, "nothing-here")}/*`];
    expect(() => carry(profile("albert"))).not.toThrow();
  });

  it("refuses unsafe paths", () => {
    expect(() => carryTranscriptsCommand("/root/x y", '"$PWD"')).toThrow();
    expect(() => carryTranscriptsCommand("/root/a", '"$PWD"', ["/root/../etc"])).toThrow();
  });

  it("covers every profile in the runner by default", () => {
    expect(PROFILE_ROOTS).toEqual(["/root/.claude", "/root/.claude-profiles/*"]);
  });
});
