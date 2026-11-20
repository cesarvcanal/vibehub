import { describe, it, expect, vi, beforeEach, onTestFinished } from "vitest";
import { AxiosError } from "axios";
import { listenForScreenErrors, reportScreenError } from "./screenErrorReport";

const post = vi.fn();
vi.mock("@/lib/api", () => ({ get: vi.fn(), post: (...args: unknown[]) => post(...args) }));

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ recorded: true });
  window.history.replaceState(null, "", "/board?project=p1");
});

function dispatchScriptError(message: string, filename: string) {
  const keepErrorFromTestRunner = (event: ErrorEvent) => event.preventDefault();
  window.addEventListener("error", keepErrorFromTestRunner);
  window.dispatchEvent(new ErrorEvent("error", { error: new Error(message), filename, cancelable: true }));
  window.removeEventListener("error", keepErrorFromTestRunner);
}

function startListening() {
  const stopListening = listenForScreenErrors();
  onTestFinished(stopListening);
}

describe("relato do erro que a tela mostrou", () => {
  it("manda a mensagem, a pilha e a tela em que aconteceu", () => {
    const crash = new Error("Cannot read properties of undefined (reading 'title')");
    reportScreenError(crash);
    expect(post).toHaveBeenCalledWith("/platform-failures/screen-errors", { message: crash.message, stack: crash.stack, screen: "/board" });
  });

  it("o mesmo erro repetido na página é relatado uma vez só", () => {
    reportScreenError(new Error("render em laço"));
    reportScreenError(new Error("render em laço"));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("erro de requisição HTTP não é relatado pela tela: o back já registra o 5xx, e o 4xx foi do usuário", () => {
    reportScreenError(new AxiosError("Request failed with status code 409"));
    expect(post).not.toHaveBeenCalled();
  });

  it("erro sem mensagem é relatado pelo nome", () => {
    reportScreenError(new RangeError(""));
    expect(post).toHaveBeenCalledWith("/platform-failures/screen-errors", expect.objectContaining({ message: "RangeError" }));
  });

  it("mensagem e pilha longas são cortadas no limite que a rota aceita", () => {
    const longError = new Error(`longa ${"m".repeat(3_000)}`);
    longError.stack = "s".repeat(30_000);
    reportScreenError(longError);
    const sentReport = post.mock.calls[0]![1] as { message: string; stack: string };
    expect(sentReport.message).toHaveLength(2_000);
    expect(sentReport.stack).toHaveLength(20_000);
  });

  it("depois de 50 mensagens diferentes na página, nenhuma outra é relatada", async () => {
    vi.resetModules();
    const { reportScreenError: reportOnFreshPage } = await import("./screenErrorReport");
    for (const index of Array.from({ length: 51 }, (_unused, position) => position)) reportOnFreshPage(new Error(`erro ${index}`));
    expect(post).toHaveBeenCalledTimes(50);
  });

  it("valor que não é Error não é relatado", () => {
    reportScreenError("só um texto");
    expect(post).not.toHaveBeenCalled();
  });

  it("relato que falha não vira erro não tratado", async () => {
    post.mockRejectedValueOnce(new Error("offline"));
    reportScreenError(new Error("relato sem rede"));
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });

  it("relato que falha pode ser repetido na próxima vez que o erro aparece", async () => {
    post.mockRejectedValueOnce(new Error("back em deploy"));
    reportScreenError(new Error("relato que caiu"));
    await vi.waitFor(() => {
      reportScreenError(new Error("relato que caiu"));
      expect(post).toHaveBeenCalledTimes(2);
    });
  });

  it("com o envio falhando sempre, o mesmo erro repetido não passa de 3 envios", async () => {
    post.mockRejectedValue(new Error("back fora do ar"));
    await vi.waitFor(() => {
      reportScreenError(new Error("erro em laço com o back fora"));
      expect(post).toHaveBeenCalledTimes(3);
    });
    await expect(post.mock.results[2]!.value).rejects.toThrow("back fora do ar");
    reportScreenError(new Error("erro em laço com o back fora"));
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("exceção não tratada de um script do próprio vibehub é relatada; a de extensão do navegador não", () => {
    startListening();
    dispatchScriptError("handler quebrou", `${window.location.origin}/assets/index.js`);
    dispatchScriptError("extensão quebrou", "chrome-extension://abc/content.js");
    expect(post.mock.calls.map((call) => (call[1] as { message: string }).message)).toEqual(["handler quebrou"]);
  });

  it("promise rejeitada sem tratamento é relatada", () => {
    startListening();
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new Error("efeito assíncrono quebrou");
    window.dispatchEvent(rejection);
    expect(post).toHaveBeenCalledWith("/platform-failures/screen-errors", expect.objectContaining({ message: "efeito assíncrono quebrou" }));
  });

  it("parar de escutar tira os ouvintes", () => {
    listenForScreenErrors()();
    dispatchScriptError("depois de parar", `${window.location.origin}/assets/index.js`);
    expect(post).not.toHaveBeenCalled();
  });
});
