import { attachCardPrs, getCard, getProject, type AttachedPrInput } from "../board/registry.js";
import { parsePrUrl, readPrInfo } from "../maestro/deliver.js";
import { logger } from "../../utils/logger.js";

/**
 * ATTACHING PRs TO A CARD (`vibehub_attach_prs`) — the request "revisa os PRs #598 a #601" becomes one PR
 * line per item on the card, each with its own "Pedir revisão". Nothing is reviewed here: attaching only
 * brings the PR from GitHub (with the card's connection, that of whoever gave the order) and records it.
 * Whoever starts the review of each one is a person, in the dialog, choosing reviewer and co-author.
 *
 * Only an OPEN PR gets in, from the SAME repository as the project and not from a fork: the fix runs on a
 * card of this repository, pushing to the PR's branch — a PR from another repo or from a fork would have nowhere to go.
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
    // The same PR asked for twice (by number and by URL) is a single line.
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
