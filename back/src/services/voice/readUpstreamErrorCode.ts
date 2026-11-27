const UPSTREAM_ERROR_CODE_MAX_CHARS = 80;

export async function readUpstreamErrorCode(response: Response): Promise<string | null> {
  // eslint-disable-next-line no-restricted-syntax -- a body that is not JSON has no code to add; the HTTP status still reaches the caller
  const body = (await response.json().catch(() => null)) as { error?: { code?: unknown; type?: unknown } } | null;
  const code = body?.error?.code ?? body?.error?.type;
  return typeof code === "string" ? code.slice(0, UPSTREAM_ERROR_CODE_MAX_CHARS) : null;
}
