export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type Base64DataUrl = {
  mimeType: string;
  encoded: string;
};

export function parseBase64DataUrl(value: string): Base64DataUrl | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(value.trim());
  return match ? { mimeType: match[1], encoded: match[2] } : null;
}

export function isSupportedImageDataUrl(value: string) {
  const parsed = parseBase64DataUrl(value);
  return Boolean(parsed && /^image\/(?:png|jpe?g|webp)$/u.test(parsed.mimeType));
}

export function parseJsonObject(content: string, errorMessage: string): unknown {
  const withoutFence = content
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(errorMessage);
  return JSON.parse(withoutFence.slice(start, end + 1)) as unknown;
}
