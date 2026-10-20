/**
 * O diff que o chat nativo desenha quando a IA altera código (o card estilo Cursor). PURE.
 *
 * A chamada da ferramenta já traz tudo: o Edit manda o trecho antigo e o novo, o Write manda o
 * arquivo inteiro. Não há leitura de disco nem pedido ao back — o diff sai do `input` da linha.
 * Linhas espelhadas do terminal só têm `{description}`: sem trechos, sem diff (null).
 */

export type DiffLine = { kind: "add" | "del" | "ctx"; text: string };

/**
 * Uma linha desenhável de diff: as do arquivo e o separador de trecho (`hunk`), que traz onde o
 * trecho começa em cada lado quando o diff diz (`@@ -a,b +c,d @@`).
 */
export type DiffRow = DiffLine | { kind: "hunk"; text: string; oldStart?: number; newStart?: number };

export type LineDiff = {
  /** Trechos alterados, cada um com suas linhas de contexto. Vazio quando nada mudou. */
  hunks: DiffLine[][];
  added: number;
  removed: number;
  /** Parte do diff não está na tela (ver `hidden`). */
  truncated?: boolean;
  /** Quantas linhas de diff ficaram de fora do que é desenhado. */
  hidden?: number;
};

export type ToolDiff = LineDiff & {
  file: string;
  /** Write: o arquivo inteiro é conteúdo novo. */
  created?: boolean;
  replaceAll?: boolean;
};

/** Teto de linhas desenhadas num card de diff: o DOM de um diff de 10 mil linhas trava a conversa. */
export const DIFF_SHOWN_MAX = 200;
/** Um Write é o arquivo inteiro; o começo basta para saber o que foi escrito. */
export const WRITE_SHOWN_MAX = 40;
/** Teto da tabela do LCS (linhas antigas × novas do miolo). Acima disso: tudo removido + tudo adicionado. */
const LCS_CELLS_MAX = 400 * 400;

/** Linhas de um texto, com CRLF igual a LF e sem a linha vazia fantasma do `\n` final. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Diff linha a linha do miolo por LCS em programação dinâmica (O(m·n), só abaixo do teto). */
function lcsOps(before: readonly string[], after: readonly string[]): DiffLine[] {
  const m = before.length;
  const n = after.length;
  const width = n + 1;
  // table[i*width + j] = LCS de before[i..] e after[j..].
  const table = new Uint32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      table[i * width + j] = before[i] === after[j]
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (before[i] === after[j]) {
      ops.push({ kind: "ctx", text: before[i]! });
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      ops.push({ kind: "del", text: before[i++]! });
    } else {
      ops.push({ kind: "add", text: after[j++]! });
    }
  }
  while (i < m) ops.push({ kind: "del", text: before[i++]! });
  while (j < n) ops.push({ kind: "add", text: after[j++]! });
  return ops;
}

/** Agrupa a sequência completa em trechos: cada mudança com `context` linhas iguais em volta. */
function toHunks(ops: readonly DiffLine[], context: number): DiffLine[][] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind === "ctx") return;
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    for (let k = from; k <= to; k++) keep[k] = true;
  });
  const hunks: DiffLine[][] = [];
  let current: DiffLine[] | null = null;
  ops.forEach((op, index) => {
    if (!keep[index]) {
      current = null;
      return;
    }
    if (!current) {
      current = [];
      hunks.push(current);
    }
    current.push(op);
  });
  return hunks;
}

/** Corta o que é desenhado em `max` linhas no total; o resto vira contagem em `hidden`. */
function capHunks(diff: LineDiff, max: number): LineDiff {
  const total = diff.hunks.reduce((sum, hunk) => sum + hunk.length, 0);
  if (total <= max) return diff;
  const hunks: DiffLine[][] = [];
  let budget = max;
  for (const hunk of diff.hunks) {
    if (budget <= 0) break;
    hunks.push(hunk.slice(0, budget));
    budget -= hunk.length;
  }
  return { ...diff, hunks, truncated: true, hidden: (diff.hidden ?? 0) + total - max };
}

/** Diff de linhas entre dois textos, em trechos com `context` linhas de contexto. PURE. */
export function lineDiff(before: string, after: string, context: number = 2): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;

  const midBefore = a.slice(prefix, a.length - suffix);
  const midAfter = b.slice(prefix, b.length - suffix);
  const coarse = midBefore.length * midAfter.length > LCS_CELLS_MAX;
  const middle = coarse
    ? [
        ...midBefore.map((text): DiffLine => ({ kind: "del", text })),
        ...midAfter.map((text): DiffLine => ({ kind: "add", text })),
      ]
    : lcsOps(midBefore, midAfter);

  // Só as linhas iguais que podem virar contexto entram na sequência; o resto do prefixo/sufixo nunca aparece.
  const head = a.slice(Math.max(0, prefix - context), prefix).map((text): DiffLine => ({ kind: "ctx", text }));
  const tail = a.slice(a.length - suffix, a.length - suffix + context).map((text): DiffLine => ({ kind: "ctx", text }));
  const ops = [...head, ...middle, ...tail];

  const added = middle.reduce((n, op) => n + (op.kind === "add" ? 1 : 0), 0);
  const removed = middle.reduce((n, op) => n + (op.kind === "del" ? 1 : 0), 0);
  const diff: LineDiff = { hunks: toHunks(ops, context), added, removed };
  return capHunks(coarse ? { ...diff, truncated: true } : diff, DIFF_SHOWN_MAX);
}

/** Trecho `[início, fim)` de uma linha que de fato mudou em relação ao seu par do outro lado. */
export type InlineMark = readonly [start: number, end: number];

/**
 * O que mudou DENTRO de cada linha de um trecho: um bloco de `−` seguido de um bloco de `+` do mesmo
 * tamanho é pareado linha a linha, e de cada par sai o miolo entre o começo e o fim em comum. É o
 * que deixa ver `2` → `3` numa linha longa sem comparar as duas no olho. Blocos de tamanhos
 * diferentes, linha toda trocada ou sem par: null (a cor da linha já diz tudo). PURE.
 */
export function inlineMarks(hunk: readonly DiffLine[]): (InlineMark | null)[] {
  const marks: (InlineMark | null)[] = hunk.map(() => null);
  let i = 0;
  while (i < hunk.length) {
    if (hunk[i]!.kind !== "del") {
      i++;
      continue;
    }
    const delStart = i;
    while (i < hunk.length && hunk[i]!.kind === "del") i++;
    const addStart = i;
    while (i < hunk.length && hunk[i]!.kind === "add") i++;
    const count = addStart - delStart;
    if (i - addStart !== count) continue;
    for (let k = 0; k < count; k++) {
      const before = hunk[delStart + k]!.text;
      const after = hunk[addStart + k]!.text;
      const limit = Math.min(before.length, after.length);
      let prefix = 0;
      while (prefix < limit && before[prefix] === after[prefix]) prefix++;
      let suffix = 0;
      while (suffix < limit - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
      if (prefix + suffix === 0) continue;
      if (before.length - suffix > prefix) marks[delStart + k] = [prefix, before.length - suffix];
      if (after.length - suffix > prefix) marks[addStart + k] = [prefix, after.length - suffix];
    }
  }
  return marks;
}

/** Texto inteiro como linhas adicionadas, desenhando no máximo `max`. */
function allAdded(text: string, max: number): LineDiff {
  const lines = splitLines(text);
  const diff: LineDiff = {
    hunks: lines.length > 0 ? [lines.map((line): DiffLine => ({ kind: "add", text: line }))] : [],
    added: lines.length,
    removed: 0,
  };
  return capHunks(diff, max);
}

type EditInput = { old_string: string; new_string: string; replace_all?: unknown };

function isEdit(value: unknown): value is EditInput {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return typeof o.old_string === "string" && typeof o.new_string === "string";
}

/** O que uma chamada de edição traz de texto, já validado. Só a forma — nenhum diff calculado. */
type EditCall =
  | { kind: "edits"; file: string; edits: EditInput[] }
  | { kind: "content"; file: string; content: string; created: boolean };

function parseEditCall(name: string, input: unknown): EditCall | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const file = typeof o.file_path === "string" ? o.file_path : null;
  switch (name) {
    case "Edit":
      return file && isEdit(o) ? { kind: "edits", file, edits: [o] } : null;
    case "MultiEdit": {
      const edits = file && Array.isArray(o.edits) ? o.edits.filter(isEdit) : [];
      return file && edits.length > 0 ? { kind: "edits", file, edits } : null;
    }
    case "Write":
      return file && typeof o.content === "string" ? { kind: "content", file, content: o.content, created: true } : null;
    case "NotebookEdit":
      // Apagar uma célula não traz o que foi apagado: não há diff honesto a desenhar.
      if (typeof o.notebook_path !== "string" || typeof o.new_source !== "string" || o.edit_mode === "delete") return null;
      return { kind: "content", file: o.notebook_path, content: o.new_source, created: false };
    default:
      return null;
  }
}

function editsDiff(edits: readonly EditInput[]): LineDiff {
  const diffs = edits.map((edit) => lineDiff(edit.old_string, edit.new_string));
  if (diffs.length === 1) return diffs[0]!;
  // Cada edição já vem com seu teto; o total ganha o mesmo teto para o card não crescer por edição.
  const hidden = diffs.reduce((n, d) => n + (d.hidden ?? 0), 0);
  return capHunks(
    {
      hunks: diffs.flatMap((d) => d.hunks),
      added: diffs.reduce((n, d) => n + d.added, 0),
      removed: diffs.reduce((n, d) => n + d.removed, 0),
      ...(diffs.some((d) => d.truncated) ? { truncated: true, hidden } : {}),
    },
    DIFF_SHOWN_MAX,
  );
}

/**
 * Esta chamada vira um card de diff? Mesma resposta que `toolDiff(...) !== null`, sem calcular o
 * diff — barato o bastante para rodar sobre a conversa inteira a cada token que chega. PURE.
 */
export function hasToolDiff(name: string, input: unknown): boolean {
  return parseEditCall(name, input) !== null;
}

/** O diff que uma chamada de ferramenta representa, ou null quando ela não altera código. PURE. */
export function toolDiff(name: string, input: unknown): ToolDiff | null {
  const call = parseEditCall(name, input);
  if (!call) return null;
  if (call.kind === "content") {
    return { file: call.file, ...allAdded(call.content, WRITE_SHOWN_MAX), ...(call.created ? { created: true } : {}) };
  }
  const replaceAll = call.edits.some((edit) => edit.replace_all === true);
  return { file: call.file, ...editsDiff(call.edits), ...(replaceAll ? { replaceAll: true } : {}) };
}

/** Os trechos de um `ToolDiff` como linhas desenháveis, com `⋯` entre um trecho e outro. PURE. */
export function hunksToRows(hunks: readonly DiffLine[][]): DiffRow[] {
  return hunks.flatMap((hunk, i): DiffRow[] => (i > 0 ? [{ kind: "hunk", text: "⋯" }, ...hunk] : [...hunk]));
}

/** O que a calha e o destaque precisam de cada linha: número (null = desconhecido) e trecho alterado. */
export type DiffRowView = { num: number | null; mark: InlineMark | null };

/**
 * Para cada linha: o número no arquivo (o antigo nas removidas, o novo nas demais), contado a partir
 * do começo do trecho, e o trecho que mudou dentro dela (`inlineMarks` por trecho). PURE.
 */
export function diffRowsView(rows: readonly DiffRow[]): DiffRowView[] {
  const marks: (InlineMark | null)[] = [];
  let hunk: DiffLine[] = [];
  const flush = () => {
    marks.push(...inlineMarks(hunk));
    hunk = [];
  };
  let oldLine: number | null = null;
  let newLine: number | null = null;
  const nums = rows.map((row): number | null => {
    if (row.kind === "hunk") {
      flush();
      marks.push(null);
      oldLine = row.oldStart ?? null;
      newLine = row.newStart ?? null;
      return null;
    }
    hunk.push(row);
    const num = row.kind === "del" ? oldLine : newLine;
    if (row.kind !== "add" && oldLine !== null) oldLine++;
    if (row.kind !== "del" && newLine !== null) newLine++;
    return num;
  });
  flush();
  return nums.map((num, i) => ({ num, mark: marks[i] ?? null }));
}
