import { attachCardPrs, getCard, getProject, type AttachedPrInput } from "../board/registry.js";
import { parsePrUrl, readPrInfo } from "../maestro/deliver.js";
import { logger } from "../../utils/logger.js";

/**
 * ANEXAR PRs A UM CARD (`vibehub_attach_prs`) — o pedido "revisa os PRs #598 a #601" vira uma linha
 * de PR por item no card, cada uma com o seu "Pedir revisão". Nada é revisado aqui: anexar só traz o
 * PR do GitHub (com a conexão do card, a de quem deu a ordem) e grava. Quem inicia a revisão de cada
 * um é uma pessoa, no diálogo, escolhendo revisor e coautor.
 *
 * Só entra PR ABERTO, do MESMO repositório do projeto e que não é de fork: a correção roda num card
 * deste repositório, empurrando na branch do PR — um PR de outro repo ou de fork não teria onde.
 */

export interface AttachedPr {
  number: number;
  title: string;
  branch: string;
  base: string;
  author?: string;
}

export interface AttachOutcome {
  attached: AttachedPr[];
  refused: { pr: number | string; reason: string }[];
}

export async function attachPrs(cardId: string, refs: (number | string)[]): Promise<AttachOutcome> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  if (card.reviewOf) throw new Error("o card de um revisor não anexa PRs: ele revisa um PR só");
  const repo = (await getProject(card.projectId))?.repoFullName;
  if (!repo) throw new Error("o projeto deste card não tem repositório no GitHub");

  const unique = [...new Set(refs.map((r) => (typeof r === "string" ? r.trim() : r)))];
  const read = await Promise.all(unique.map(async (ref) => ({ ref, found: await readPrInfo(card.id, ref) })));

  const out: AttachOutcome = { attached: [], refused: [] };
  const toWrite = new Map<number, AttachedPrInput>();
  for (const { ref, found } of read) {
    if ("error" in found) {
      out.refused.push({ pr: ref, reason: `nao_encontrado: ${found.error}` });
      continue;
    }
    const pr = found.pr;
    const reason =
      parsePrUrl(pr.url)?.repo.toLowerCase() !== repo.toLowerCase() ? `outro_repositorio: o PR é de ${parsePrUrl(pr.url)?.repo ?? pr.url}, o card é de ${repo}`
        : pr.fork ? "fork: a branch do PR está em outro repositório, a correção não teria onde dar push"
          : pr.state === "MERGED" ? "mergeado: já está na base"
            : pr.state === "CLOSED" ? "fechado: o PR foi fechado sem merge"
              : null;
    if (reason) {
      out.refused.push({ pr: ref, reason });
      continue;
    }
    // O mesmo PR pedido duas vezes (pelo número e pela URL) é uma linha só.
    if (toWrite.has(pr.number)) continue;
    toWrite.set(pr.number, { number: pr.number, url: pr.url, base: pr.base, branch: pr.branch, author: pr.author, title: pr.title });
    out.attached.push({ number: pr.number, title: pr.title, branch: pr.branch, base: pr.base, ...(pr.author ? { author: pr.author } : {}) });
  }
  if (toWrite.size) await attachCardPrs(card.id, [...toWrite.values()]);
  logger.info(
    { audit: true, action: "review.attach", card: card.worktreeSlug, attached: [...toWrite.keys()], refused: out.refused.length },
    "PRs attached to a card",
  );
  return out;
}
