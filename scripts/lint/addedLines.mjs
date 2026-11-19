const NEW_PATH_LINE = /^\+\+\+ (?:b\/(.*?)|\/dev\/null)\t?$/;
const HUNK_HEADER = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/;

function hunkLines(header) {
  const [, start, count = "1"] = HUNK_HEADER.exec(header);
  return Array.from({ length: Number(count) }, (_, offset) => Number(start) + offset);
}

export function parseAddedLines(diffU0) {
  const fileSections = diffU0.split(/^diff --git /m).slice(1);
  const entries = fileSections.flatMap((section) => {
    const lines = section.split("\n");
    const newPath = lines.map((line) => NEW_PATH_LINE.exec(line)).find(Boolean)?.[1];
    if (newPath === undefined) return [];
    const added = lines.filter((line) => HUNK_HEADER.test(line)).flatMap(hunkLines);
    return [[newPath, new Set(added)]];
  });
  return new Map(entries);
}
