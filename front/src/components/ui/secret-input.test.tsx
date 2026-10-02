import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SecretInput } from "./secret-input";

/**
 * THE INCIDENT (produção, 02/10/2026): o formulário "adicionar conta do GitHub" abriu PREENCHIDO
 * com o login salvo do dono — o nome da conta veio "cesar" e a caixa do token veio com a senha do
 * painel. A segunda pessoa não conseguia cadastrar a conta dela, e apertar o botão teria mandado
 * uma senha pro GitHub como se fosse token. `autocomplete="off"` não segura: navegador ignora em
 * campo com cara de senha.
 */
describe("SecretInput — segredo não é login", () => {
  it("pede ao navegador para NÃO tratar como credencial salva", () => {
    render(<SecretInput name="vibehub-github-token" aria-label="token" />);
    const field = screen.getByLabelText("token");
    // `new-password` é o valor que os navegadores respeitam; `off` eles ignoram aqui.
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
