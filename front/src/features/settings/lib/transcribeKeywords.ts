export function parseTranscribeKeywords(text: string): string[] {
  return text
    .split(/[,\r\n]+/)
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword !== "");
}

export function formatTranscribeKeywords(keywords: readonly string[]): string {
  return keywords.join(", ");
}
