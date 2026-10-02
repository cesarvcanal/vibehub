import { describe, it, expect } from "vitest";
import { resolveIdentity } from "./identity.js";

/**
 * A card with no actor must resolve to what it resolved to BEFORE this existed — that is what makes
 * the feature additive. Everything else here is the field-by-field rule.
 */

const settings = { git: { name: "César Canal", email: "cesarvcanal@gmail.com" } };
const connections = [{ id: "c-cesar" }, { id: "c-mussa" }];
const project = { githubConnectionId: "c-cesar" };

describe("identidade em vigor", () => {
  it("sem ator, vale o projeto e a instalação", () => {
    expect(resolveIdentity({ project, settings, connections })).toEqual({
      connectionId: "c-cesar", name: "César Canal", email: "cesarvcanal@gmail.com",
    });
  });

  it("ator completo ganha do projeto nos três campos", () => {
    const actor = {
      userId: "u2", githubConnectionId: "c-mussa",
      gitName: "wellesley-mussolini", gitEmail: "xerif.off@gmail.com",
    };
    expect(resolveIdentity({ actor, project, settings, connections })).toEqual({
      connectionId: "c-mussa", name: "wellesley-mussolini", email: "xerif.off@gmail.com",
    });
  });

  it("é campo por campo: ator só com conexão mantém o autor da instalação", () => {
    const actor = { userId: "u2", githubConnectionId: "c-mussa" };
    expect(resolveIdentity({ actor, project, settings, connections })).toEqual({
      connectionId: "c-mussa", name: "César Canal", email: "cesarvcanal@gmail.com",
    });
  });

  it("ator só com autor mantém a conexão do projeto", () => {
    const actor = { userId: "u2", gitName: "wellesley-mussolini", gitEmail: "xerif.off@gmail.com" };
    expect(resolveIdentity({ actor, project, settings, connections })).toEqual({
      connectionId: "c-cesar", name: "wellesley-mussolini", email: "xerif.off@gmail.com",
    });
  });

  it("conexão do ator que não existe mais cai na do projeto, não quebra o push", () => {
    const actor = { userId: "u2", githubConnectionId: "apagada" };
    expect(resolveIdentity({ actor, project, settings, connections }).connectionId).toBe("c-cesar");
  });

  it("ator removido do vibehub (null) se comporta como ausente", () => {
    expect(resolveIdentity({ actor: null, project, settings, connections }).connectionId).toBe("c-cesar");
  });

  it("projeto sem conexão e ator sem conexão: a primeira da lista, igual ao clone", () => {
    expect(resolveIdentity({ project: {}, settings, connections }).connectionId).toBe("c-cesar");
  });

  it("conexão do projeto apagada também cai na primeira", () => {
    expect(resolveIdentity({ project: { githubConnectionId: "apagada" }, settings, connections }).connectionId)
      .toBe("c-cesar");
  });

  it("instalação sem nenhuma conexão: sem conexão, nunca inventada", () => {
    expect(resolveIdentity({ project: {}, settings, connections: [] }).connectionId).toBeUndefined();
  });
});
