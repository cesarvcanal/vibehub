import { describe, it, expect } from "vitest";
import { buildFailureSignature, normalizeFailureMessage } from "./signature.js";

describe("assinatura de falha", () => {
  it("ignora o que muda entre ocorrências: ids, números, hex e caminhos", () => {
    expect(normalizeFailureMessage("Card 3f1c2a9e-1111-2222-3333-444455556666 timed out after 91234 ms at /root/work/x.ts"))
      .toBe(normalizeFailureMessage("card 0a0b0c0d-aaaa-bbbb-cccc-ddddeeeeffff timed out after 5 ms at /srv/other/y.ts"));
  });

  it("separa fonte e componente diferentes com a mesma mensagem", () => {
    const base = { component: "services/sdk/manager", symptom: "driver gone" };
    expect(buildFailureSignature({ source: "backend_error", ...base }))
      .not.toBe(buildFailureSignature({ source: "agent_report", ...base }));
  });
});
