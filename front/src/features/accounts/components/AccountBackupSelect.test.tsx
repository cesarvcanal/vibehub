import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { resetLanguage, setLanguage } from "@/i18n";
import { AccountBackupSelect } from "./AccountBackupSelect";

const get = vi.fn();
const put = vi.fn();
vi.mock("@/lib/api", () => ({
  get: (...args: unknown[]) => get(...args),
  put: (...args: unknown[]) => put(...args),
}));
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: (...args: unknown[]) => toastError(...args) }) }));

const OPTIONS = [
  { slug: "default", label: "tech" },
  { slug: "albert", label: "Albert" },
  { slug: "cesar", label: "César" },
];

beforeEach(() => {
  setLanguage("pt-BR");
  get.mockResolvedValue({ user: null });
  put.mockImplementation(async (_url: string, body: { backupAccountSlug: string | null }) => ({ accountSlug: "albert", ...body }));
});

afterEach(() => {
  resetLanguage();
  vi.clearAllMocks();
});

function renderSelect(value: string | null = null) {
  return renderApp(<AccountBackupSelect accountSlug="albert" accountLabel="Albert" value={value} options={OPTIONS} />);
}

describe("AccountBackupSelect", () => {
  it("oferece as outras contas e 'Sem reserva', nunca a própria conta", () => {
    renderSelect();

    const select = screen.getByRole("combobox", { name: "Conta reserva de Albert" });
    const labels = within(select).getAllByRole("option").map((option) => option.textContent);
    expect(labels).toEqual(["Sem reserva", "tech", "César"]);
  });

  it("escolher uma conta grava a reserva dela", async () => {
    renderSelect();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Conta reserva de Albert" }), "cesar");

    await waitFor(() => expect(put).toHaveBeenCalledWith("/accounts/albert/backup", { backupAccountSlug: "cesar" }));
  });

  it("'Sem reserva' limpa a reserva", async () => {
    renderSelect("cesar");

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Conta reserva de Albert" }), "");

    await waitFor(() => expect(put).toHaveBeenCalledWith("/accounts/albert/backup", { backupAccountSlug: null }));
  });

  it("falha ao gravar avisa a pessoa", async () => {
    put.mockRejectedValueOnce(new Error("boom"));
    renderSelect();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Conta reserva de Albert" }), "cesar");

    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });
});
