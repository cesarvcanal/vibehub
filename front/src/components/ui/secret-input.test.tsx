import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SecretInput } from "./secret-input";

/**
 * THE INCIDENT (production, 02/10/2026): the "add GitHub account" form opened PREFILLED with the
 * owner's saved login — the account name came as "cesar" and the token box came with the panel's
 * password. The second person could not register their own account, and pressing the button would
 * have sent a password to GitHub as if it were a token. `autocomplete="off"` does not hold: browsers
 * ignore it on a field that looks like a password.
 */
describe("SecretInput — segredo não é login", () => {
  it("pede ao navegador para NÃO tratar como credencial salva", () => {
    render(<SecretInput name="vibehub-github-token" aria-label="token" />);
    const field = screen.getByLabelText("token");
    // `new-password` is the value browsers respect; `off` they ignore here.
    expect(field).toHaveAttribute("autocomplete", "new-password");
    expect(field).toHaveAttribute("type", "password");
  });

  it("desliga também os gerenciadores que ignoram o autocomplete", () => {
    render(<SecretInput name="vibehub-github-token" aria-label="token" />);
    const field = screen.getByLabelText("token");
    expect(field).toHaveAttribute("data-1p-ignore");
    expect(field).toHaveAttribute("data-lpignore", "true");
    expect(field).toHaveAttribute("data-bwignore", "true");
  });

  it("o nome do campo não tem cara de usuário/senha — a heurística lê isso", () => {
    render(<SecretInput name="vibehub-github-token" aria-label="token" />);
    const name = screen.getByLabelText("token").getAttribute("name") ?? "";
    expect(/user|login|email|^password$/i.test(name)).toBe(false);
  });

  it("serve para o campo de TEXTO ao lado do segredo — é ele que vira 'usuário'", () => {
    render(<SecretInput name="vibehub-github-account-label" type="text" aria-label="rótulo" />);
    const field = screen.getByLabelText("rótulo");
    expect(field).toHaveAttribute("type", "text");
    expect(field).toHaveAttribute("autocomplete", "new-password");
  });
});
