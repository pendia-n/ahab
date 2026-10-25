export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}
export async function boundedBody(request: Request, max: number) {
  if (Number(request.headers.get("content-length") || 0) > max)
    throw new HttpError(413, "That request is too large.");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) {
        await reader.cancel();
        throw new HttpError(413, "That request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
export async function readJson(request: Request): Promise<Record<string, any>> {
  if (Number(request.headers.get("content-length") || 0) > 32000)
    throw new HttpError(413, "That request is too large.");
  const text = new TextDecoder().decode(await boundedBody(request, 32000));
  try {
    const b = JSON.parse(text);
    if (!b || typeof b !== "object" || Array.isArray(b)) throw 0;
    return b;
  } catch {
    throw new HttpError(400, "Send a valid JSON request.");
  }
}
export function textValue(
  v: unknown,
  max: number,
  label: string,
  optional = false,
): string {
  if (optional && (v === undefined || v === null)) return "";
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new HttpError(400, `${label} must be 1–${max} characters.`);
  return v.trim();
}
export function assertMutation(request: Request) {
  if (request.headers.get("authorization")?.startsWith("Bearer ")) return;
  if (
    request.headers.get("origin") !== new URL(request.url).origin ||
    request.headers.get("X-Ahab-Request") !== "1"
  )
    throw new HttpError(403, "Please refresh the page and try again.");
}
