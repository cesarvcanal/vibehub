import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { toast } from "sonner";
import {
  bundleFromHtml,
  holdReload,
  releaseReload,
  resetReloadHoldsForTesting,
  useVersionCheck,
  VERSION_IDLE_MS,
} from "@/lib/versionCheck";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

/**
 * A ABA QUE FICA NO FRONT VELHO (produção, 2026-10-19): o deploy subiu a correção, a aba aberta
 * antes seguiu desenhando o bug, e a pessoa viu "não corrigiu". O painel tech.multi já resolvia
 * isso (useVersionCheck); o vibehub não tinha. Estes testes cercam o comportamento inteiro: aviso,
 * recarga sozinha só quando é seguro, e nunca no meio de um upload ou de uma gravação.
 */

const html = (hash: string) => `<!doctype html><script type="module" src="/assets/index-${hash}.js"></script>`;

let served = html("AAA");
let reload: ReturnType<typeof vi.fn>;
let hidden = false;

function Probe({ intervalMs = 1_000 }: { intervalMs?: number }) {
  useVersionCheck({ intervalMs, reload: reload as () => void });
  return null;
}

/** Deixa as promessas do fetch assentarem com o relógio falso. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  served = html("AAA");
  reload = vi.fn();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => served })));
  vi.mocked(toast).mockClear();
  resetReloadHoldsForTesting();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bundleFromHtml", () => {
  it("extrai o bundle de entrada do Vite", () => {
    expect(bundleFromHtml(html("Ab_9-z"))).toBe("/assets/index-Ab_9-z.js");
  });
  it("sem bundle (dev server, página de erro): null — nada a comparar", () => {
    expect(bundleFromHtml('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
    expect(bundleFromHtml("")).toBeNull();
  });
});

describe("useVersionCheck", () => {
  it("mesma versão: nenhum aviso, nenhuma recarga", async () => {
    render(<Probe />);
    await flush();
    await tick(5_000);
    expect(toast).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("versão nova com a aba em uso: avisa na hora e só recarrega depois de um tempo sem interação", async () => {
    render(<Probe />);
    await flush();
    served = html("BBB");
    window.dispatchEvent(new Event("pointerdown"));
    await tick(1_000);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();

    // a pessoa está mexendo: cada interação adia a recarga
    await tick(VERSION_IDLE_MS - 2_000);
    window.dispatchEvent(new Event("keydown"));
    await tick(VERSION_IDLE_MS - 1_000);
    expect(reload).not.toHaveBeenCalled();

    await tick(1_001);
    expect(reload).toHaveBeenCalledTimes(1);
    // e o aviso não se repete a cada sondagem
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("versão nova com a aba visível mas parada há mais que o limite: recarrega já", async () => {
    render(<Probe />);
    await flush();
    await tick(VERSION_IDLE_MS);
    served = html("BBB");
    await tick(1_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("versão nova com a aba em segundo plano: recarrega já", async () => {
    render(<Probe />);
    await flush();
    hidden = true;
    served = html("BBB");
    await tick(1_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a aba vai para o segundo plano depois do aviso: recarrega nesse momento", async () => {
    render(<Probe />);
    await flush();
    served = html("BBB");
    await tick(1_000);
    expect(reload).not.toHaveBeenCalled();
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("o botão do aviso recarrega na hora", async () => {
    render(<Probe />);
    await flush();
    served = html("BBB");
    await tick(1_000);
    const opts = vi.mocked(toast).mock.calls[0]![1] as unknown as { action: { onClick: () => void } };
    opts.action.onClick();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("upload ou gravação em andamento SEGURA a recarga sozinha — e ela acontece quando soltam", async () => {
    render(<Probe />);
    await flush();
    holdReload("upload:c1");
    hidden = true;
    served = html("BBB");
    await tick(1_000);
    document.dispatchEvent(new Event("visibilitychange"));
    await tick(VERSION_IDLE_MS * 2);
    expect(reload).not.toHaveBeenCalled();

    releaseReload("upload:c1");
    await tick(1_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("duas retenções: só recarrega quando as DUAS soltam", async () => {
    render(<Probe />);
    await flush();
    holdReload("upload:c1");
    holdReload("recording:c2");
    hidden = true;
    served = html("BBB");
    await tick(1_000);
    releaseReload("upload:c1");
    await tick(1_000);
    expect(reload).not.toHaveBeenCalled();
    releaseReload("recording:c2");
    await tick(1_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("falha de rede ou HTML sem bundle não conta como versão nova", async () => {
    render(<Probe />);
    await flush();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await tick(3_000);
    served = "<html>502</html>";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => served })));
    await tick(3_000);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, text: async () => html("ZZZ") })));
    await tick(3_000);
    expect(toast).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("a primeira leitura que falhou não vira referência: a próxima boa é a versão carregada", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    render(<Probe />);
    await flush();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => served })));
    await tick(1_000);
    await tick(1_000);
    expect(toast).not.toHaveBeenCalled();
  });

  it("desmontado, para de sondar", async () => {
    const { unmount } = render(<Probe />);
    await flush();
    unmount();
    const calls = vi.mocked(fetch).mock.calls.length;
    await tick(10_000);
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
  });
});
