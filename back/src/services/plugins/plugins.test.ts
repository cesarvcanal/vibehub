import { describe, it, expect } from "vitest";
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

  it("never lets a plugin break the open — every command carries `|| true`", () => {
    for (const line of pluginInstallLines([DEFAULT], ["superpowers"])) {
      if (line.includes("claude plugin")) expect(line.endsWith("|| true")).toBe(true);
    }
  });

  it("the default profile runs WITHOUT CLAUDE_CONFIG_DIR (that is what makes it the default)", () => {
    expect(pluginInstallLines([DEFAULT], ["code-review"]).join("\n")).not.toContain("CLAUDE_CONFIG_DIR");
  });

  it("forced, it drops the guard — and with nothing wanted it writes nothing at all", () => {
    expect(pluginInstallLines([DEFAULT], ["code-review"], true).some((l) => l.startsWith("if ["))).toBe(false);
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
    expect(script).not.toContain(`claude plugin install 'code-review@${OFFICIAL_MARKETPLACE}' >/dev/null 2>&1 || true\nrm`);
    // the account profile has nothing yet: both go in, addressed through CLAUDE_CONFIG_DIR
    expect(script).toContain(`CLAUDE_CONFIG_DIR='${ACCOUNT}' claude plugin install 'code-review@${OFFICIAL_MARKETPLACE}'`);
  });

  it("re-stamps the marker so the next card open agrees with what was just applied", () => {
    const signature = pluginsSignature(["code-review"]);
    const script = reconcileLines([DEFAULT], ["code-review"], installed).join("\n");
    expect(script).toContain("rm -f '/root/.claude'/.plugins-*"); // the old markers go
    expect(script).toContain(`: > '/root/.claude'/.plugins-${signature}`);
  });

  it("wanting nothing uninstalls everything vibehub put there, and leaves no marker", () => {
    const script = reconcileLines([DEFAULT], [], installed).join("\n");
    expect(script).toContain(`claude plugin uninstall 'code-review@${OFFICIAL_MARKETPLACE}'`);
    expect(script).toContain(`claude plugin uninstall 'old-thing@${OFFICIAL_MARKETPLACE}'`);
    expect(script).not.toContain(": > '/root/.claude'/.plugins-");
  });

  it("one profile refusing must not abort the sweep over the others", () => {
    for (const line of reconcileLines(profiles, ["code-review"], installed)) {
      if (line.includes("claude plugin")) expect(line.endsWith("|| true")).toBe(true);
    }
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
