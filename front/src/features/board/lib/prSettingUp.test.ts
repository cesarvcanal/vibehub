import { describe, it, expect } from "vitest";
import { prSettingUpHolder } from "./prSettingUp";

const refusal = (status: number, data: unknown) => ({ response: { status, data } });

describe("prSettingUpHolder", () => {
  it("devolve quem está montando a PR no 409 pr_em_montagem", () => {
    expect(prSettingUpHolder(refusal(409, { error: "pr_em_montagem: albert está montando a análise do PR #636", username: "albert" }))).toBe("albert");
  });

  it.each([
    ["outro status", refusal(400, { error: "pr_em_montagem: albert", username: "albert" })],
    ["outro 409", refusal(409, { error: "conflict", username: "albert" })],
    ["409 sem username", refusal(409, { error: "pr_em_montagem: albert" })],
    ["corpo em texto", refusal(409, "pr_em_montagem")],
    ["sem resposta", new Error("Network Error")],
  ])("%s não é a recusa de montagem", (_case, err) => {
    expect(prSettingUpHolder(err)).toBeNull();
  });
});
