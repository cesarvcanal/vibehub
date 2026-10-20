import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * visibleProjects lê compartilhamentos e cards UMA vez para a lista inteira; a regra é a mesma de
 * canAccessProject, projeto a projeto. O teste confere as duas lado a lado em todos os casos.
 */

let dir = "";
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-access-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function load() {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  const registry = await import("../services/board/registry.js");
  registry.resetForTesting();
  const access = await import("./access.js");
  return { registry, access };
}

const owner = { id: "u-owner", username: "dono", role: "owner" as const, createdAt: "" };
const member = { id: "u-member", username: "membro", role: "member" as const, createdAt: "" };

describe("visibleProjects — a mesma regra de canAccessProject, numa leitura só", () => {
  it("projeto compartilhado, card compartilhado e nada compartilhado", async () => {
    const { registry, access } = await load();
    const viaProject = await registry.createProject({ name: "via-projeto" });
    const viaCard = await registry.createProject({ name: "via-card" });
    const hidden = await registry.createProject({ name: "escondido" });
    const card = await registry.createCard({ projectId: viaCard.id, title: "dado" });
    await registry.createCard({ projectId: hidden.id, title: "não dado" });
    await registry.shareWith({ kind: "project", targetId: viaProject.id, userId: member.id, level: "view" });
    await registry.shareWith({ kind: "card", targetId: card.id, userId: member.id, level: "work" });
    const projects = [viaProject, viaCard, hidden];

    const visible = await access.visibleProjects(member, projects);
    expect(visible.map((p) => p.name)).toEqual(["via-projeto", "via-card"]);
    for (const p of projects) {
      expect(visible.includes(p)).toBe(await access.canAccessProject(member, p.id));
    }
    expect(await access.visibleProjects(owner, projects)).toEqual(projects);
    expect(await access.visibleProjects(null, projects)).toEqual([]);
  });

  it("membro sem nenhum compartilhamento não vê nada (e nem lê os cards)", async () => {
    const { registry, access } = await load();
    const p = await registry.createProject({ name: "qualquer" });
    const spy = vi.spyOn(registry, "listAllCards");
    expect(await access.visibleProjects(member, [p])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
