const encoder = new TextEncoder();
export function base64url(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
export function unbase64url(s: string) {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
}
export function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function digest(value: string) {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
}
export async function hashPassword(
  value: string,
  salt = base64url(crypto.getRandomValues(new Uint8Array(16))),
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(value),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const result = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: unbase64url(salt),
      iterations: 100000,
    },
    key,
    256,
  );
  return `pbkdf2-sha256$100000$${salt}$${base64url(new Uint8Array(result))}`;
}
export async function verifyPassword(value: string, encoded: string) {
  const p = encoded.split("$");
  if (p.length !== 4 || p[0] !== "pbkdf2-sha256" || p[1] !== "100000")
    return false;
  const actual = await hashPassword(value, p[2]);
  if (actual.length !== encoded.length) return false;
  let different = 0;
  for (let i = 0; i < actual.length; i++)
    different |= actual.charCodeAt(i) ^ encoded.charCodeAt(i);
  return different === 0;
}
async function hmacKey(secret: string) {
  if (!secret || secret.length < 32)
    throw new Error("Session signing is not configured.");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function signJwt(claims: Record<string, unknown>, secret: string) {
  const value = `${base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })))}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
  return `${value}.${base64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(value))))}`;
}
export async function verifyJwt(
  token: string,
  secret: string,
): Promise<{ sub: string; sid: string; exp: number } | null> {
  try {
    const [head, body, signature, ...extra] = token.split(".");
    if (extra.length || !signature) return null;
    const h = JSON.parse(new TextDecoder().decode(unbase64url(head)));
    if (h.alg !== "HS256" || h.typ !== "JWT") return null;
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await hmacKey(secret),
        unbase64url(signature),
        encoder.encode(`${head}.${body}`),
      ))
    )
      return null;
    const c = JSON.parse(new TextDecoder().decode(unbase64url(body)));
    return c.iss === "ahab" &&
      c.aud === "ahab" &&
      typeof c.sub === "string" &&
      typeof c.sid === "string" &&
      Number.isInteger(c.exp) &&
      c.exp > Date.now() / 1000
      ? c
      : null;
  } catch {
    return null;
  }
}
