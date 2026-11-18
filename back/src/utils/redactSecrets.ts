/**
 * Removes token-looking strings from text before it leaves the module: GitHub tokens, Claude OAuth
 * tokens, bearer headers and `x-access-token:` basics. Deliberately conservative — it does NOT touch
 * 40-hex strings, which are almost always git SHAs a reader wants to see. PURE.
 */
export function redactSecrets(text: string): string {
  return String(text ?? "")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/sk-ant-[A-Za-z0-9._-]{10,}/g, "[redacted]")
    .replace(/x-access-token:[A-Za-z0-9._-]{10,}/gi, "x-access-token:[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{20,}/gi, "Bearer [redacted]");
}
