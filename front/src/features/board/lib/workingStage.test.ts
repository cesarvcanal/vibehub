import { describe, it, expect } from "vitest";
import {
  workingStage,
  VERB_ROTATE_SECONDS,
  STILL_AFTER_SECONDS,
  LONG_AFTER_SECONDS,
} from "./workingStage";
import { ptBR } from "@/i18n/pt-BR";
import { en } from "@/i18n/en";

describe("workingStage — o que o indicador diz enquanto o turno corre", () => {
  it("troca o verbo com o tempo: a tela prova que a coisa está viva", () => {
    const first = workingStage("thinking", 0).verb;
    expect(workingStage("thinking", VERB_ROTATE_SECONDS - 1).verb).toBe(first);
    const second = workingStage("thinking", VERB_ROTATE_SECONDS).verb;
    expect(second).not.toBe(first);
    const third = workingStage("thinking", VERB_ROTATE_SECONDS * 2).verb;
    expect(third).not.toBe(second);
    // Dá a volta — o revezamento não tem fim, e o verbo nunca fica indefinido.
    expect(workingStage("thinking", VERB_ROTATE_SECONDS * 3).verb).toBe(first);
  });

  it("escala a nota: rápido, 'ainda', e 'faz tempo'", () => {
    expect(workingStage("thinking", 0).note).toBe("sdk.note.thinking");
    expect(workingStage("thinking", STILL_AFTER_SECONDS - 1).note).toBe("sdk.note.thinking");
    expect(workingStage("thinking", STILL_AFTER_SECONDS).note).toBe("sdk.note.thinkingStill");
    expect(workingStage("thinking", LONG_AFTER_SECONDS - 1).note).toBe("sdk.note.thinkingStill");
    expect(workingStage("thinking", LONG_AFTER_SECONDS).note).toBe("sdk.note.thinkingLong");
  });

  it("cada fase fala do que ela é — ferramenta não diz 'pensando'", () => {
    expect(workingStage("tool", 0).note).toBe("sdk.note.tool");
    expect(workingStage("answering", STILL_AFTER_SECONDS).note).toBe("sdk.note.answeringStill");
    expect(workingStage("working", LONG_AFTER_SECONDS).note).toBe("sdk.note.workingLong");
    // Esperar o agente subir não ganha sinônimo: um verbo só, sempre o mesmo.
    expect(workingStage("preparing", 0).verb).toBe("sdk.preparing");
    expect(workingStage("preparing", VERB_ROTATE_SECONDS * 5).verb).toBe("sdk.preparing");
  });

  it("segundo torto não quebra a frase", () => {
    expect(workingStage("working", -5)).toEqual(workingStage("working", 0));
    expect(workingStage("working", Number.NaN)).toEqual(workingStage("working", 0));
    expect(workingStage("working", 3.7)).toEqual(workingStage("working", 3));
  });

  it("toda chave que ela devolve existe nos DOIS idiomas", () => {
    const kinds = ["preparing", "thinking", "answering", "tool", "working"] as const;
    const seconds = [0, VERB_ROTATE_SECONDS, VERB_ROTATE_SECONDS * 2, STILL_AFTER_SECONDS, LONG_AFTER_SECONDS];
    for (const kind of kinds) {
      for (const s of seconds) {
        const { verb, note } = workingStage(kind, s);
        expect(ptBR[verb], `pt-BR ${verb}`).toBeTruthy();
        expect(en[verb], `en ${verb}`).toBeTruthy();
        expect(ptBR[note], `pt-BR ${note}`).toBeTruthy();
        expect(en[note], `en ${note}`).toBeTruthy();
      }
    }
  });
});
