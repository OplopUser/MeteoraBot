export function normalizeRpcUrls(primaryUrl: string, fallbackUrls: string | string[]) {
  const extras = Array.isArray(fallbackUrls)
    ? fallbackUrls
    : fallbackUrls
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

  return Array.from(new Set([primaryUrl, ...extras]));
}

export function isRecoverableRpcStatus(status: number) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export function isRecoverableRpcError(error: unknown) {
  const message = (error as Error).message ?? "";

  return (
    message.includes("HTTP error (429)") ||
    message.includes("Too Many Requests") ||
    message.includes("fetch failed") ||
    message.includes("network error") ||
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT")
  );
}
