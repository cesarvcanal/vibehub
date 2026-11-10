import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  OFFICIAL_MARKETPLACE,
  assertPluginName,
  buildPluginCatalogScript,
  buildPluginReadScript,
  buildReconcileScript,
  parseInstalledByProfile,
  parsePluginCatalog,
  pluginId,
  pluginInstallLines,
  pluginsSignature,
  reconcileLines,
} from "./plugins.js";
import { SETUP_RETRY_AFTER_MIN } from "../mcp/mcp.js";

/**
 * OFFICIAL PLUGINS — the rules that decide what reaches a runner's command line and what comes
 * back from it. Every name here ends up as an argument of `claude plugin install`, so the shape of
 * a name is not cosmetics: it is the boundary.
 */

const DEFAULT = "" as const; // the default profile: no CLAUDE_CONFIG_DIR
const ACCOUNT = "/root/.claude-profiles/vendas";

describe("names are the boundary", () => {
  it("accepts marketplace slugs and refuses anything that could be an argument", () => {
    expect(assertPluginName("code-review")).toBe("code-review");
    expect(assertPluginName("superpowers")).toBe("superpowers");
    for (const bad of ["", "-leading", "a b", "a;rm -rf /", "../../etc", "a@b", "$(id)", "x".repeat(70)]) {
      expect(() => assertPluginName(bad)).toThrow(/invalid plugin name/);
    }
  });

  it("addresses a plugin by marketplace, never by bare name", () => {
    expect(pluginId("code-review")).toBe(`code-review@${OFFICIAL_MARKETPLACE}`);
  });
});

describe("pluginInstallLines — the card-open path", () => {
  it("adds the marketplace and installs, per profile, guarded by the signature marker", () => {
    const lines = pluginInstallLines([ACCOUNT], ["code-review"]);
    const script = lines.join("\n");
    expect(script).toContain(`CLAUDE_CONFIG_DIR='${ACCOUNT}' claude plugin marketplace add`);
    expect(script).toContain(`claude plugin install 'code-review@${OFFICIAL_MARKETPLACE}'`);
    expect(lines[0]).toContain(`if [ ! -f '${ACCOUNT}/.plugins-${pluginsSignature(["code-review"])}' ]`);
    expect(lines[lines.length - 1]).toBe("fi");
  });

  it("never lets a plugin break the open — every command carries an `||` that cannot fail", () => {
    for (const line of pluginInstallLines([DEFAULT], ["superpowers"])) {
      if (line.includes("claude plugin")) expect(line).toMatch(/\|\| (true|VIBEHUB_PLUGINS_FAILED=1)$/);
    }
  });

  it("the default profile runs WITHOUT CLAUDE_CONFIG_DIR (that is what makes it the default)", () => {
    expect(pluginInstallLines([DEFAULT], ["code-review"]).join("\n")).not.toContain("CLAUDE_CONFIG_DIR");
  });

  it("forced, it drops the guard — and with nothing wanted it writes nothing at all", () => {
    expect(pluginInstallLines([DEFAULT], ["code-review"], true).some((l) => l.startsWith("if [ ! -f"))).toBe(false);
    expect(pluginInstallLines([DEFAULT], [])).toEqual([]);
  });

  it("the signature depends on the SET, not on the order it was typed in", () => {
    expect(pluginsSignature(["a", "b"])).toBe(pluginsSignature(["b", "a"]));
    expect(pluginsSignature(["a"])).not.toBe(pluginsSignature(["a", "b"]));
  });

  it("refuses a name it would otherwise put in a shell line", () => {
    expect(() => pluginInstallLines([DEFAULT], ["oops; rm -rf /"])).toThrow(/invalid plugin name/);
  });
});

/**
 * The marker is a PROMISE that the set is installed — the hot path skips the whole block while it
 * exists. These run the lines for real (bash, with `claude` stubbed as a shell function), because
 * "a failed install leaves no marker" is a property of the script's control flow, not of its text.
 */
describe("pluginInstallLines — the marker only after a clean install", () => {
  const profile = `/tmp/vibehub-plugins-${randomUUID().slice(0, 8)}`;
  const calls = `${profile}-calls`;
  const bash = (script: string): string => execFileSync("bash", ["-c", script], { encoding: "utf8" });
  const run = (claudeExit: number): void => {
    bash([
      `claude() { echo x >> ${calls}; return ${claudeExit}; }`, "set -e", ...pluginInstallLines([profile], ["code-review"]),
    ].join("\n"));
  };
  /** How many times the CLI was booted so far — a marketplace add or an install is a network clone. */
  const cliCalls = (): number => Number(bash(`cat ${calls} 2>/dev/null | wc -l`).trim());
  /** The SET marker only (the one that lets the hot path skip the block). */
  const markers = (): string => bash(`ls -A ${profile} 2>/dev/null | grep -E '^[.]plugins-[0-9a-f]+$' || true`).trim();
  afterEach(() => {
    bash(`rm -rf ${profile} ${calls}`);
  });

  it("a failed install (network down) leaves NO marker — the next open tries again", () => {
    run(1);
    expect(markers()).toBe("");
  });

  it("a clean install writes the marker, and the open still never breaks on a failure", () => {
    run(0);
    expect(markers()).toBe(`.plugins-${pluginsSignature(["code-review"])}`);
    expect(() => run(1)).not.toThrow();
  });

  it("a lasting failure (a plugin gone from the marketplace) is retried once per backoff — not on every open", () => {
    run(1);
    const first = cliCalls();
    expect(first).toBeGreaterThan(0);

    run(1); // the next open: no marketplace add, no clone attempt
    expect(cliCalls()).toBe(first);

    bash(`touch -d '-${SETUP_RETRY_AFTER_MIN + 1} minutes' ${profile}/.plugins-*.failed`);
    run(0);
    expect(cliCalls()).toBeGreaterThan(first);
    expect(markers()).toBe(`.plugins-${pluginsSignature(["code-review"])}`);
  });
});

describe("reading the runner back", () => {
  const stdout = [
    "### /root/.claude",
    JSON.stringify([
      { id: `code-review@${OFFICIAL_MARKETPLACE}`, version: "1.0.0" },
      { id: "something@somebody-elses-marketplace", version: "2.0.0" },
    ]),
    "### /root/.claude-profiles/vendas",
    "[]",
  ].join("\n");

  it("maps each profile to what OUR marketplace put there", () => {
    expect(parseInstalledByProfile(stdout)).toEqual({
      "/root/.claude": ["code-review"],
      "/root/.claude-profiles/vendas": [],
    });
  });

  it("an unreadable block reads as empty — the safe direction is to install", () => {
    expect(parseInstalledByProfile("### /root/.claude\nclaude: command not found")).toEqual({ "/root/.claude": [] });
    expect(parseInstalledByProfile("")).toEqual({});
  });
});

describe("parsePluginCatalog", () => {
  const stdout = JSON.stringify({
    installed: [{ id: `code-review@${OFFICIAL_MARKETPLACE}` }],
    available: [
      { name: "code-review", description: "Automated  code\nreview", marketplaceName: OFFICIAL_MARKETPLACE, installCount: 482222 },
      { name: "superpowers", description: "Brainstorming, TDD", marketplaceName: OFFICIAL_MARKETPLACE, installCount: 1126764 },
      { name: "elsewhere", description: "another marketplace", marketplaceName: "someone-else", installCount: 9_000_000 },
      { name: "../../etc/passwd", marketplaceName: OFFICIAL_MARKETPLACE },
    ],
  });

  it("keeps the official marketplace only, most installed first", () => {
    const out = parsePluginCatalog(stdout, ["superpowers"]);
    expect(out.map((p) => p.name)).toEqual(["superpowers", "code-review"]);
  });

  it("says, per plugin, what the runner HAS and what the install WANTS", () => {
    const out = parsePluginCatalog(stdout, ["superpowers"]);
    expect(out.find((p) => p.name === "code-review")).toMatchObject({ installed: true, enabled: false });
    expect(out.find((p) => p.name === "superpowers")).toMatchObject({ installed: false, enabled: true });
  });

  it("flattens the description, and drops an entry whose name is not a name", () => {
    expect(parsePluginCatalog(stdout)[1]!.description).toBe("Automated code review");
    expect(parsePluginCatalog(stdout).some((p) => p.name.includes("/"))).toBe(false);
  });

  it("a runner that answered nothing is an empty catalogue, not a crash", () => {
    expect(parsePluginCatalog("claude: not found")).toEqual([]);
    expect(parsePluginCatalog("{}")).toEqual([]);
  });
});

describe("reconcileLines — install what is missing, remove what nobody wants", () => {
  const profiles = [DEFAULT, ACCOUNT];
  const installed = { "/root/.claude": ["code-review", "old-thing"], [ACCOUNT]: [] as string[] };

  it("sends exactly the difference, per profile", () => {
    const script = reconcileLines(profiles, ["code-review", "superpowers"], installed).join("\n");
    // default profile: superpowers is missing, old-thing is no longer wanted, code-review is left alone
    expect(script).toContain(`claude plugin install 'superpowers@${OFFICIAL_MARKETPLACE}'`);
    expect(script).toContain(`claude plugin uninstall 'old-thing@${OFFICIAL_MARKETPLACE}'`);
    expect(script.split("\n").filter((l) => l.startsWith("claude plugin install 'code-review@"))).toEqual([]);
    // the account profile has nothing yet: both go in, addressed through CLAUDE_CONFIG_DIR
    expect(script).toContain(`CLAUDE_CONFIG_DIR='${ACCOUNT}' claude plugin install 'code-review@${OFFICIAL_MARKETPLACE}'`);
  });

  it("re-stamps the marker so the next card open agrees with what was just applied", () => {
    const signature = pluginsSignature(["code-review"]);
    const script = reconcileLines([DEFAULT], ["code-review"], installed).join("\n");
    expect(script).toContain("rm -f '/root/.claude'/.plugins-*"); // the old markers go
    expect(script).toContain(`: > '/root/.claude/.plugins-${signature}'`);
  });

  it("wanting nothing uninstalls everything vibehub put there, and leaves no marker", () => {
    const script = reconcileLines([DEFAULT], [], installed).join("\n");
    expect(script).toContain(`claude plugin uninstall 'code-review@${OFFICIAL_MARKETPLACE}'`);
    expect(script).toContain(`claude plugin uninstall 'old-thing@${OFFICIAL_MARKETPLACE}'`);
    expect(script).not.toContain(": > '/root/.claude'/.plugins-");
  });

});

describe("reconcileLines — run by bash: the marker only after a clean apply, and a failure is reported", () => {
  const root = `/tmp/vibehub-reconcile-${randomUUID().slice(0, 8)}`;
  const ok = `${root}/ok`;
  const bad = `${root}/bad`;
  /**
   * `claude` fails inside the profile named `failIn` (the network dropping mid-clone) and succeeds
   * everywhere else. Returns the exit status and stderr instead of throwing.
   */
  const apply = (lines: string[], failIn = ""): { status: number; stderr: string } => {
    const out = spawnSync("bash", ["-c", [
      `claude() { [ "\${CLAUDE_CONFIG_DIR:-}" = ${JSON.stringify(failIn)} ] && [ -n ${JSON.stringify(failIn)} ] && return 1; return 0; }`,
      ...lines,
    ].join("\n")], { encoding: "utf8" });
    return { status: out.status ?? -1, stderr: out.stderr };
  };
  const markerOf = (dir: string): string =>
    execFileSync("bash", ["-c", `ls -A ${dir} 2>/dev/null | grep -E '^[.]plugins-[0-9a-f]+$' || true`], { encoding: "utf8" }).trim();
  const signature = pluginsSignature(["code-review"]);
  afterEach(() => {
    execFileSync("rm", ["-rf", root]);
  });

  it("a failed install leaves NO marker in that profile, still sweeps the others, and fails the apply", () => {
    execFileSync("mkdir", ["-p", bad, ok]); // profiles that exist: the marker CAN be written
    const result = apply(reconcileLines([bad, ok], ["code-review"], {}), bad);
    expect(markerOf(bad)).toBe("");
    expect(markerOf(ok)).toBe(`.plugins-${signature}`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(bad);
    expect(result.stderr).not.toContain(ok);
    expect(result.stderr).toMatch(/runner/); // the route reports it as the runner's failure (502)
  });

  it("a marker left by an earlier apply does not survive a re-install that failed", () => {
    execFileSync("bash", ["-c", `mkdir -p ${bad} && : > ${bad}/.plugins-${signature}`]);
    // Somebody removed the plugin by hand: the read says it is missing, the re-install fails.
    expect(apply(reconcileLines([bad], ["code-review"], { [bad]: [] }), bad).status).not.toBe(0);
    expect(markerOf(bad)).toBe("");
  });

  it("a failed uninstall also fails the apply — wanting nothing still leaves no marker", () => {
    const result = apply(reconcileLines([bad], [], { [bad]: ["old-thing"] }), bad);
    expect(result.status).not.toBe(0);
    expect(markerOf(bad)).toBe("");
  });

  it("a clean apply writes the marker, replaces the old one, and exits 0", () => {
    execFileSync("bash", ["-c", `mkdir -p ${ok} && : > ${ok}/.plugins-dead`]);
    const result = apply(reconcileLines([ok], ["code-review"], { [ok]: ["old-thing"] }));
    expect(result).toEqual({ status: 0, stderr: "" });
    expect(markerOf(ok)).toBe(`.plugins-${signature}`);
  });
});

describe("the scripts that reach the host", () => {
  it("wrap the work in a docker exec with a reserved heredoc delimiter", () => {
    for (const script of [
      buildPluginCatalogScript("vibehub-runner"),
      buildPluginReadScript("vibehub-runner", [DEFAULT]),
      buildReconcileScript("vibehub-runner", [DEFAULT], ["code-review"], {}),
    ]) {
      expect(script.startsWith("set -e\ndocker exec -i 'vibehub-runner' bash -s <<'VIBEHUB_PLUGINS'")).toBe(true);
      expect(script.trimEnd().endsWith("VIBEHUB_PLUGINS")).toBe(true);
    }
  });

  it("the read script asks each profile in turn, under its own header", () => {
    const script = buildPluginReadScript("vibehub-runner", [DEFAULT, ACCOUNT]);
    expect(script).toContain('echo "### /root/.claude"');
    expect(script).toContain(`echo "### ${ACCOUNT}"`);
    expect(script).toContain(`CLAUDE_CONFIG_DIR='${ACCOUNT}' claude plugin list --json`);
  });
});
