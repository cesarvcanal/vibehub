import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cardGitConfigPath,
  cardGitEnv,
  writeCardGitConfigLines,
  ghWrapperSource,
  installGhWrapperLines,
  GH_WRAPPER_PATH,
  REAL_GH_PATH,
} from "./runnerIdentity.js";

/**
 * A AUTORIA SEGUE QUEM DEU A ÚLTIMA ORDEM — em TODO git e TODO gh do card, não só na worktree.
 *
 * Os scripts gerados aqui rodam no runner, em caminhos absolutos (/root/.vibehub, /usr/local/bin).
 * Estes testes os executam DE VERDADE (sh e git reais), com esses caminhos trocados por um diretório
 * temporário: o bug que importa é de semântica do git/gh, e uma asserção só de texto passaria com o
 * comportamento errado (foi assim que o `--local` vazou identidade entre cards).
 */

const run = promisify(execFile);
const CARD = "4f4be9b3-3d6b-4c13-a66c-739b912089f2";
const TOKEN_MUSSA = "ghp_mussaMussaMussaMussaMussaMussa01";
const TOKEN_CESAR = "ghp_cesarCesarCesarCesarCesarCesar02";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "vibehub-runner-id-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** The production paths, relocated under the temp dir — the script's text is otherwise untouched. */
function relocate(text: string): string {
  return text
    .split("/root/.vibehub").join(`${root}/vibehub`)
    .split(GH_WRAPPER_PATH).join(`${root}/bin/gh`)
    .split(REAL_GH_PATH).join(`${root}/real/gh`);
}

async function sh(lines: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await run("bash", ["-c", ["set -e", ...lines.map(relocate)].join("\n")], {
    env: { PATH: process.env.PATH, HOME: root, ...env },
  });
  return stdout;
}

/** The env a card process is born with, pointing at the relocated include file. */
function cardEnv(cardId = CARD): Record<string, string> {
  return Object.fromEntries(cardGitEnv(cardId).map(([k, v]) => [k, relocate(v)]));
}

async function writeToken(cardId: string, token: string): Promise<void> {
  await mkdir(join(root, "vibehub", "gh"), { recursive: true });
  await writeFile(join(root, "vibehub", "gh", `${cardId}.token`), token, { mode: 0o600 });
}

/** git with NOTHING from the machine running the tests: no system config, an empty global one. */
async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const globalCfg = join(root, "global.gitconfig");
  await writeFile(globalCfg, "", { flag: "a" });
  const { stdout } = await run("git", ["-C", cwd, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalCfg,
      GIT_TERMINAL_PROMPT: "0",
      ...env,
    },
  });
  // Only the final newline goes: a `--get-all` whose first value is the reset ('') starts with "\n".
  return stdout.replace(/\n$/, "");
}

async function freshRepo(name: string): Promise<string> {
  const dir = join(root, name);
  await run("git", ["init", "-q", dir]);
  return dir;
}

/** `git credential fill` for a host, from a card process — the password git would push with. */
async function fill(repo: string, host: string): Promise<string | undefined> {
  const { stdout } = await run("bash", ["-c", `printf 'protocol=https\\nhost=${host}\\n\\n' | git -C ${repo} credential fill`], {
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, "global.gitconfig"),
      GIT_TERMINAL_PROMPT: "0",
      ...cardEnv(),
    },
  });
  return /password=(\S+)/.exec(stdout)?.[1];
}

describe("o include git do card — vale para QUALQUER repositório que o card tocar", () => {
  it("o caminho e o ambiente: um arquivo por card, incluído no escopo de comando", () => {
    expect(cardGitConfigPath(CARD)).toBe(`/root/.vibehub/git/${CARD}.gitconfig`);
    expect(cardGitEnv(CARD)).toEqual([
      ["GIT_CONFIG_COUNT", "1"],
      ["GIT_CONFIG_KEY_0", "include.path"],
      ["GIT_CONFIG_VALUE_0", `/root/.vibehub/git/${CARD}.gitconfig`],
    ]);
    expect(() => cardGitConfigPath("../../etc/passwd")).toThrow();
  });

  it("GIT DE VERDADE: um clone extra do card (fora da worktree) commita como o ator, não como a instalação", async () => {
    await sh(writeCardGitConfigLines(CARD, { name: "wellesley-mussolini", email: "xerif.off@gmail.com" }, true));
    // `_repos/<outro>`: o clone que a regra "terminal sem cerca" manda fazer. Nenhuma config local.
    const extra = await freshRepo("_repos/bank-api");
    await git(extra, ["commit", "-q", "--allow-empty", "-m", "fix"], cardEnv());
    expect(await git(extra, ["log", "-1", "--format=%an <%ae>"])).toBe("wellesley-mussolini <xerif.off@gmail.com>");
  });

  it("GIT DE VERDADE: ganha da identidade gravada no próprio repositório (escopo de comando)", async () => {
    await sh(writeCardGitConfigLines(CARD, { name: "César Canal", email: "cesarvcanal@gmail.com" }, true));
    const repo = await freshRepo("outro");
    await git(repo, ["config", "user.name", "vibehub"]);
    await git(repo, ["config", "user.email", "vibehub@runner"]);
    expect(await git(repo, ["config", "user.email"], cardEnv())).toBe("cesarvcanal@gmail.com");
  });

  it("GIT DE VERDADE: o push pede a credencial ao arquivo do card, e a troca de ator vale SEM reiniciar nada", async () => {
    const repo = await freshRepo("push");
    // O helper ambiente do runner (o `gh auth git-credential` da org) estaria aqui: tem que ser ZERADO.
    await git(repo, ["config", "credential.helper", "!f() { echo username=u; echo password=token-da-org; }; f"]);
    await writeToken(CARD, TOKEN_CESAR);
    await sh(writeCardGitConfigLines(CARD, { name: "César Canal", email: "cesarvcanal@gmail.com" }, true));
    expect(await fill(repo, "github.com")).toBe(TOKEN_CESAR);

    // O Mussa manda a próxima mensagem: o vibehub reescreve o token e o include — o MESMO processo
    // (mesmo ambiente) passa a empurrar como ele.
    await writeToken(CARD, TOKEN_MUSSA);
    await sh(writeCardGitConfigLines(CARD, { name: "wellesley-mussolini", email: "xerif.off@gmail.com" }, true));
    expect(await fill(repo, "github.com")).toBe(TOKEN_MUSSA);
    expect(await git(repo, ["config", "user.name"], cardEnv())).toBe("wellesley-mussolini");
  }, 30_000);

  it("GIT DE VERDADE: o token do GitHub NUNCA vai para outro host — um remote qualquer não o recebe", async () => {
    const repo = await freshRepo("outro-host");
    await git(repo, ["config", "credential.helper", "!f() { echo username=u; echo password=credencial-do-gitlab; }; f"]);
    await writeToken(CARD, TOKEN_MUSSA);
    await sh(writeCardGitConfigLines(CARD, { name: "wellesley-mussolini", email: "xerif.off@gmail.com" }, true));
    expect(await fill(repo, "gitlab.com")).toBe("credencial-do-gitlab");
    expect(await fill(repo, "github.com")).toBe(TOKEN_MUSSA);
  }, 30_000);

  it("sem token (instalação sem conta GitHub): o include NÃO mexe na credencial — fica o login de antes", async () => {
    await sh(writeCardGitConfigLines(CARD, { name: "César Canal", email: "cesarvcanal@gmail.com" }, false));
    const repo = await freshRepo("sem-token");
    await git(repo, ["config", "credential.helper", "!f() { echo username=u; echo password=login-de-antes; }; f"]);
    expect(await fill(repo, "github.com")).toBe("login-de-antes");
  });

  it("reescrever é idempotente: rodar de novo não acumula helper", async () => {
    const id = { name: "César Canal", email: "cesarvcanal@gmail.com" };
    await sh(writeCardGitConfigLines(CARD, id, true));
    await sh(writeCardGitConfigLines(CARD, id, true));
    const repo = await freshRepo("idem");
    const helpers = (await git(repo, ["config", "--get-all", "credential.https://github.com.helper"], cardEnv())).split("\n");
    // O reset ('') e o do card: exatamente dois, por mais que o script rode.
    expect(helpers).toEqual(["", expect.stringContaining(`${root}/vibehub/gh/${CARD}.token`)]);
  });

  it("include que ainda não existe (card recém-nascido) é ignorado em silêncio — git nunca quebra", async () => {
    const repo = await freshRepo("sem-include");
    await git(repo, ["config", "user.name", "Quem Estava"]);
    expect(await git(repo, ["config", "user.name"], cardEnv())).toBe("Quem Estava");
  });

  it("nome com '#' ou ';' (comentário no gitconfig) chega inteiro; nome com caractere de shell é recusado", async () => {
    await sh(writeCardGitConfigLines(CARD, { name: "Dev #1; time", email: "dev@x.com" }, false));
    const repo = await freshRepo("comentario");
    expect(await git(repo, ["config", "user.name"], cardEnv())).toBe("Dev #1; time");
    expect(() => writeCardGitConfigLines(CARD, { name: "x$(id)", email: "a@x.com" }, false)).toThrow();
    expect(() => writeCardGitConfigLines(CARD, { name: "x", email: "a b@x.com" }, false)).toThrow();
  });
});

describe("o gh do card — sempre com o token de quem deu a última ordem", () => {
  /** The wrapper and a fake real gh that only reports which token it was given. */
  async function installFakes(): Promise<string> {
    await mkdir(join(root, "real"), { recursive: true });
    await mkdir(join(root, "bin"), { recursive: true });
    const real = join(root, "real", "gh");
    await writeFile(real, '#!/bin/sh\necho "token=${GH_TOKEN:-<ambiente>}"\nfor a in "$@"; do echo "arg=$a"; done\nexit 7\n');
    await chmod(real, 0o755);
    await sh(installGhWrapperLines());
    return join(root, "bin", "gh");
  }

  async function gh(wrapper: string, env: Record<string, string>, args: string[] = []): Promise<{ out: string; code: number }> {
    try {
      const { stdout } = await run(wrapper, args, { env: { PATH: process.env.PATH, ...env } });
      return { out: stdout, code: 0 };
    } catch (e) {
      const err = e as { stdout?: string; code?: number };
      return { out: err.stdout ?? "", code: err.code ?? -1 };
    }
  }

  it("dentro do card usa o token do arquivo do card — mesmo com um GH_TOKEN velho no ambiente", async () => {
    const wrapper = await installFakes();
    await writeToken(CARD, TOKEN_CESAR);
    const { out } = await gh(wrapper, { VIBEHUB_CARD_ID: CARD, GH_TOKEN: "ghp_doBootDaSessaoQueFicouVelho" });
    expect(out).toContain(`token=${TOKEN_CESAR}`);
  });

  it("a troca de ator vale na próxima chamada, sem reiniciar a sessão", async () => {
    const wrapper = await installFakes();
    await writeToken(CARD, TOKEN_CESAR);
    expect((await gh(wrapper, { VIBEHUB_CARD_ID: CARD })).out).toContain(`token=${TOKEN_CESAR}`);
    await writeToken(CARD, TOKEN_MUSSA);
    expect((await gh(wrapper, { VIBEHUB_CARD_ID: CARD })).out).toContain(`token=${TOKEN_MUSSA}`);
  });

  it("fora de um card, ou num card sem token, é o gh de sempre (nada muda)", async () => {
    const wrapper = await installFakes();
    expect((await gh(wrapper, {})).out).toContain("token=<ambiente>");
    expect((await gh(wrapper, { GH_TOKEN: "ghp_quemChamouExplicitamente" })).out).toContain("token=ghp_quemChamouExplicitamente");
    expect((await gh(wrapper, { VIBEHUB_CARD_ID: "card-sem-token" })).out).toContain("token=<ambiente>");
  });

  it("um id de card esquisito nunca vira caminho", async () => {
    const wrapper = await installFakes();
    await mkdir(join(root, "vibehub"), { recursive: true });
    await writeFile(join(root, "vibehub", "segredo.token"), "ghp_naoEraPraLerEsteArquivoAquiNao");
    expect((await gh(wrapper, { VIBEHUB_CARD_ID: "../segredo" })).out).toContain("token=<ambiente>");
  });

  it("argumentos passam intactos e o código de saída é o do gh de verdade", async () => {
    const wrapper = await installFakes();
    const { out, code } = await gh(wrapper, {}, ["pr", "review", "--body", "frase com espaço e 'aspas'"]);
    expect(out).toContain("arg=frase com espaço e 'aspas'");
    expect(code).toBe(7);
  });

  it("instala por cima de uma versão anterior dele mesmo, mas NUNCA por cima de outro binário", async () => {
    await installFakes();
    const wrapperPath = join(root, "bin", "gh");
    await writeFile(wrapperPath, "#!/bin/sh\n# VIBEHUB_GH_WRAPPER (versão velha)\nexit 1\n");
    await sh(installGhWrapperLines());
    expect(await readFile(wrapperPath, "utf8")).toBe(relocate(ghWrapperSource()));

    await writeFile(wrapperPath, "#!/bin/sh\n# um gh que alguém instalou aqui\n");
    await sh(installGhWrapperLines());
    expect(await readFile(wrapperPath, "utf8")).toBe("#!/bin/sh\n# um gh que alguém instalou aqui\n");
  });

  it("sem o gh de verdade no runner, não instala nada (um wrapper apontando pro nada quebraria o gh)", async () => {
    await mkdir(join(root, "bin"), { recursive: true });
    await sh(installGhWrapperLines());
    await expect(readFile(join(root, "bin", "gh"), "utf8")).rejects.toThrow();
  });
});
