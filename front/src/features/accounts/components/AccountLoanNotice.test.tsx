import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { resetLanguage, setLanguage } from "@/i18n";
import type { AccountLoan } from "@/api/types";
import { AccountLoanNotice } from "./AccountLoanNotice";

const NOW = new Date("2026-11-23T15:30:00-03:00").getTime();
const RENEWS_AT = new Date("2026-11-23T18:00:00-03:00").getTime();
const LOAN: AccountLoan = { originalAccount: "albert", renewsAt: RENEWS_AT, exhausted: [] };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  setLanguage("pt-BR");
});

afterEach(() => {
  vi.useRealTimers();
  resetLanguage();
});

describe("AccountLoanNotice", () => {
  it("enquanto a conta original não renova, diz em qual conta o card segue e não oferece voltar", () => {
    render(<AccountLoanNotice loan={LOAN} currentAccount="cesar" returning={false} onReturn={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("Este card segue na conta cesar porque a conta albert está sem limite até");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("quando a conta original renova, avisa e oferece voltar para ela", () => {
    const onReturn = vi.fn();
    render(<AccountLoanNotice loan={LOAN} currentAccount="cesar" returning={false} onReturn={onReturn} />);

    act(() => { vi.setSystemTime(RENEWS_AT); vi.advanceTimersByTime(1_000); });
    fireEvent.click(screen.getByRole("button", { name: "Voltar para albert" }));

    expect(screen.getByRole("status")).toHaveTextContent("A conta albert renovou.");
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("sem horário de renovação conhecido, oferece tentar voltar", () => {
    render(<AccountLoanNotice loan={{ originalAccount: "albert", exhausted: [] }} currentAccount="cesar" returning={false} onReturn={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Tentar voltar para albert" })).toBeEnabled();
  });

  it("enquanto a volta está em andamento, o botão não aceita outro clique", () => {
    render(<AccountLoanNotice loan={{ originalAccount: "albert", exhausted: [] }} currentAccount="cesar" returning onReturn={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Tentar voltar para albert" })).toBeDisabled();
  });
});
