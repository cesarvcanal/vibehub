import { afterEach, describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import { ptBR } from "@/i18n/pt-BR";
import {
  LANGUAGE_KEY,
  getLanguage,
  interpolate,
  resolveLanguage,
  setLanguage,
  t,
  translateApiError,
} from "@/i18n";

/**
 * The rules underneath every translated string. They are worth their own file because getting them
 * wrong is invisible: a missed plural or a dropped `{name}` still renders, it just renders wrong.
 */

/** jsdom exposes `navigator.language` as a prototype getter, so it has to be redefined, not set. */
function withNavigatorLanguage(value: string, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "language");
  Object.defineProperty(navigator, "language", { value, configurable: true });
  try {
    run();
  } finally {
    delete (navigator as unknown as Record<string, unknown>).language;
    if (original) Object.defineProperty(Navigator.prototype, "language", original);
  }
}

afterEach(() => {
  setLanguage("en");
  localStorage.removeItem(LANGUAGE_KEY);
});

describe("language resolution", () => {
  it("prefers the stored choice over everything the browser says", () => {
    localStorage.setItem(LANGUAGE_KEY, "pt-BR");
    withNavigatorLanguage("en-US", () => expect(resolveLanguage()).toBe("pt-BR"));
    localStorage.setItem(LANGUAGE_KEY, "en");
    withNavigatorLanguage("pt-BR", () => expect(resolveLanguage()).toBe("en"));
  });

  it("falls back to the browser: anything Portuguese lands on pt-BR", () => {
    localStorage.removeItem(LANGUAGE_KEY);
    withNavigatorLanguage("pt-BR", () => expect(resolveLanguage()).toBe("pt-BR"));
    withNavigatorLanguage("pt", () => expect(resolveLanguage()).toBe("pt-BR"));
    withNavigatorLanguage("PT-pt", () => expect(resolveLanguage()).toBe("pt-BR"));
  });

  it("falls back to English for anything else — that is the open-source default", () => {
    localStorage.removeItem(LANGUAGE_KEY);
    withNavigatorLanguage("en-US", () => expect(resolveLanguage()).toBe("en"));
    withNavigatorLanguage("es-AR", () => expect(resolveLanguage()).toBe("en"));
    withNavigatorLanguage("", () => expect(resolveLanguage()).toBe("en"));
  });

  it("ignores a stored value that is not one of ours", () => {
    localStorage.setItem(LANGUAGE_KEY, "klingon");
    withNavigatorLanguage("en-US", () => expect(resolveLanguage()).toBe("en"));
  });

  it("stores the choice and stamps it on <html> when it is switched", () => {
    setLanguage("pt-BR");
    expect(getLanguage()).toBe("pt-BR");
    expect(localStorage.getItem(LANGUAGE_KEY)).toBe("pt-BR");
    expect(document.documentElement.lang).toBe("pt-BR");
    setLanguage("en");
    expect(document.documentElement.lang).toBe("en");
  });
});

describe("interpolation", () => {
  it("replaces every {name} with its value", () => {
    expect(interpolate("Delete “{name}”?", { name: "billing" })).toBe("Delete “billing”?");
    expect(interpolate("{a} and {a} and {b}", { a: 1, b: 2 })).toBe("1 and 1 and 2");
  });

  it("leaves a placeholder alone when nothing was passed for it", () => {
    // Better a visible `{name}` than a sentence with a hole in it that nobody notices.
    expect(interpolate("Hello {name}", {})).toBe("Hello {name}");
    expect(interpolate("Hello {name}", { name: undefined })).toBe("Hello {name}");
    expect(interpolate("Hello {name}")).toBe("Hello {name}");
  });

  it("interpolates through t", () => {
    expect(t("card.projectChip", { name: "vibehub" })).toBe("Project: vibehub");
    setLanguage("pt-BR");
    expect(t("card.projectChip", { name: "vibehub" })).toBe("Projeto: vibehub");
  });
});

describe("plurals", () => {
  it("picks the .one form for exactly one and .other for everything else", () => {
    expect(t("board.cards", { n: 1 })).toBe("1 card");
    expect(t("board.cards", { n: 0 })).toBe("0 cards");
    expect(t("board.cards", { n: 7 })).toBe("7 cards");
    expect(t("board.projects", { n: 1 })).toBe("1 project");
    expect(t("board.projects", { n: 3 })).toBe("3 projects");
  });

  it("agrees in Portuguese too", () => {
    setLanguage("pt-BR");
    expect(t("board.projects", { n: 1 })).toBe("1 projeto");
    expect(t("board.projects", { n: 4 })).toBe("4 projetos");
    expect(t("applyOutcome.now", { n: 1 })).toBe("aplicado a 1 terminal");
    expect(t("applyOutcome.now", { n: 2 })).toBe("aplicado a 2 terminais");
  });

  it("leaves a key with no plural siblings alone even when a count is passed", () => {
    expect(t("common.save", { n: 2 })).toBe("Save");
  });
});

describe("lookup", () => {
  it("falls back to English when pt-BR has no such key", () => {
    setLanguage("pt-BR");
    // Every product name key is identical in both, so use one only English defines.
    expect(t("__missing.key.for.this.test")).toBe("__missing.key.for.this.test");
  });

  it("returns the key itself when nothing has it — a visible bug beats a blank button", () => {
    expect(t("nope.not.a.key")).toBe("nope.not.a.key");
  });

  it("keeps the two dictionaries in step", () => {
    const missing = Object.keys(en).filter((key) => ptBR[key] === undefined);
    expect(missing).toEqual([]);
    const extra = Object.keys(ptBR).filter((key) => en[key] === undefined);
    expect(extra).toEqual([]);
  });
});

describe("translateApiError", () => {
  it("leaves the server's own English alone, capitalisation included", () => {
    expect(translateApiError("Invalid username or password")).toBe("Invalid username or password");
    expect(translateApiError("fatal: repository not found")).toBe("fatal: repository not found");
  });

  it("translates the common ones in Portuguese", () => {
    setLanguage("pt-BR");
    expect(translateApiError("not found")).toBe("não encontrado");
    expect(translateApiError("Not Authenticated")).toBe("não autenticado");
    expect(translateApiError("invalid username or password")).toBe("usuário ou senha inválidos");
    expect(translateApiError("the runner is unreachable")).toBe("o runner está inacessível");
  });

  it("passes an unknown message straight through — half-translated stderr helps nobody", () => {
    setLanguage("pt-BR");
    const stderr = "docker: Error response from daemon: no such image";
    expect(translateApiError(stderr)).toBe(stderr);
  });
});
