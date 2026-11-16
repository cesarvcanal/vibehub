import type { AnalysisPerson, ProjectPull } from "@/api/types";

/**
 * Whoever opened a PR does not review it: compared by the GitHub login their commits would carry, the
 * same check the server makes (`revisor_igual_autor`). PURE.
 */
export function isPrAuthor(person: AnalysisPerson, pull: Pick<ProjectPull, "author">): boolean {
  return !!person.githubLogin && person.githubLogin.toLowerCase() === pull.author.toLowerCase();
}

/** The reviewer picked when the choice opens: the one signed in, unless they opened the PR. PURE. */
export function defaultReviewerId(people: AnalysisPerson[], meId: string | undefined, pull: Pick<ProjectPull, "author">): string {
  const me = people.find((p) => p.id === meId);
  return me && !isPrAuthor(me, pull) ? me.id : "";
}
