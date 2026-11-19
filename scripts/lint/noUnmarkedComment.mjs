const EXCEPTION_MARKERS = ["external:", "limitation:", "legacy-name:"];
const DIRECTIVE_NEEDING_REASON = /^eslint-disable(-next-line|-line)?\b/;
const DIRECTIVE_WITHOUT_REASON = [/^eslint-enable\b/, /^@ts-expect-error\b/, /^\/ <reference /, /^@vite-ignore$/];

function classifyComment(comment) {
  const text = comment.value.trim();
  if (DIRECTIVE_NEEDING_REASON.test(text)) return text.includes(" -- ") ? null : "directiveWithoutReason";
  if (DIRECTIVE_WITHOUT_REASON.some((directive) => directive.test(text))) return null;
  const marker = EXCEPTION_MARKERS.find((candidate) => text.startsWith(candidate));
  if (!marker) return "unmarked";
  if (text.slice(marker.length).trim() === "") return "emptyMarker";
  if (comment.loc.start.line !== comment.loc.end.line) return "multiline";
  return null;
}

export const noUnmarkedComment = {
  meta: {
    type: "suggestion",
    docs: { description: "Comentário novo só nas exceções da §3 do AGENTS.md, com marcador ou como diretiva" },
    schema: [],
    messages: {
      unmarked:
        "AGENTS.md §3: o código se explica pelo nome; o porquê vai para o commit e o PR. Comentário só nas exceções, com marcador: `external:` (regra externa + referência), `limitation:` (limitação técnica) ou `legacy-name:` (nome legado que não pode mudar).",
      directiveWithoutReason: "AGENTS.md §3: diretiva de ferramenta sempre com o motivo: `eslint-disable-next-line <regra> -- <motivo>`.",
      emptyMarker: "AGENTS.md §3: o marcador de exceção precisa dizer a referência ou o motivo depois dos dois-pontos.",
      multiline: "AGENTS.md §3: a exceção cabe em uma linha.",
    },
  },
  create(context) {
    return {
      Program() {
        const reports = context.sourceCode
          .getAllComments()
          .filter((comment) => comment.type !== "Shebang")
          .map((comment) => ({ comment, messageId: classifyComment(comment) }))
          .filter((classified) => classified.messageId !== null);
        reports.forEach(({ comment, messageId }) => context.report({ loc: comment.loc, messageId }));
      },
    };
  },
};
