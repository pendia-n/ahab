import type { AhabEnv, User } from "./types";
import {
  digest,
  hashPassword,
  randomToken,
  signJwt,
  verifyJwt,
  verifyPassword,
} from "./crypto";
import {
  SESSION_SECONDS,
  usernameValid,
  passwordValid,
  passcodeValid,
} from "./policy";
import { HttpError, json, readJson, textValue } from "./http";
const COOKIE = "__Host-ahab";
export const sessionCookie = (token: string, seconds = SESSION_SECONDS) =>
  `${COOKIE}=${token}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
export function requestToken(request: Request) {
  const bearer = request.headers.get("authorization");
  if (bearer?.startsWith("Bearer ")) return bearer.slice(7);
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1) || ""
  );
}
export async function getUser(
  request: Request,
  env: AhabEnv,
): Promise<User | null> {
  const token = requestToken(request);
  if (!token || !env.AHAB_JWT_SECRET || !env.DB) return null;
  const c = await verifyJwt(token, env.AHAB_JWT_SECRET);
  if (!c) return null;
  const r = await env.DB.prepare(
    "SELECT u.id,u.username,u.recovery_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.expires_at>?",
  )
    .bind(c.sid, c.sub, Date.now())
    .first<{ id: string; username: string; recovery_hash: string | null }>();
  return r
    ? { id: r.id, username: r.username, recoveryEnabled: !!r.recovery_hash }
    : null;
}
export async function requireUser(request: Request, env: AhabEnv) {
  const u = await getUser(request, env);
  if (!u) throw new HttpError(401, "Please sign in to continue.");
  return u;
}
export async function rateLimit(
  env: AhabEnv,
  key: string,
  limit: number,
  windowMs: number,
) {
  const bucket = Math.floor(Date.now() / windowMs);
  const r = await env.DB.prepare(
    "INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
  )
    .bind(`${key}:${bucket}`, (bucket + 1) * windowMs)
    .first<{ count: number }>();
  if (!r || r.count > limit)
    throw new HttpError(429, "Too many attempts. Please try again later.");
}
export async function requestRate(
  env: AhabEnv,
  r: Request,
  area: string,
  limit = 12,
) {
  await rateLimit(
    env,
    `${area}:ip:${await digest(r.headers.get("CF-Connecting-IP") || "local")}`,
    limit,
    15 * 60000,
  );
}
async function newSession(env: AhabEnv, user: User, verifiedHash: string) {
  const now = Date.now(),
    sid = crypto.randomUUID(),
    exp = Math.floor(now / 1000) + SESSION_SECONDS;
  const token = await signJwt(
    {
      sub: user.id,
      sid,
      iat: Math.floor(now / 1000),
      exp,
      iss: "ahab",
      aud: "ahab",
    },
    env.AHAB_JWT_SECRET,
  );
  const inserted = await env.DB.prepare(
    "INSERT INTO sessions(id,user_id,expires_at,created_at) SELECT ?,id,?,? FROM users WHERE id=? AND password_hash=?",
  )
    .bind(sid, exp * 1000, now, user.id, verifiedHash)
    .run();
  if (!inserted.meta.changes)
    throw new HttpError(409, "Your password changed. Please sign in again.");
  return json({ user }, 200, { "Set-Cookie": sessionCookie(token) });
}
const dummyHash =
  "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export async function authRoute(path: string, request: Request, env: AhabEnv) {
  if (path === "auth/me" && request.method === "GET")
    return json({ user: await getUser(request, env) });
  if (path === "auth/username" && request.method === "GET") {
    await requestRate(env, request, "availability", 60);
    const u = new URL(request.url).searchParams.get("username") || "";
    return json({
      available:
        usernameValid(u) &&
        !(await env.DB.prepare("SELECT id FROM users WHERE username=?")
          .bind(u)
          .first()),
    });
  }
  if (request.method !== "POST")
    throw new HttpError(405, "Method not allowed.");
  if (path === "auth/logout") {
    const c = await verifyJwt(requestToken(request), env.AHAB_JWT_SECRET);
    if (c)
      await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(c.sid).run();
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  await requestRate(env, request, path);
  const b = await readJson(request);
  if (path === "auth/signup") {
    const username = textValue(b.username, 24, "Username"),
      password = typeof b.password === "string" ? b.password : "";
    if (!usernameValid(username))
      throw new HttpError(
        400,
        "Use 3–24 letters, numbers or underscores for your username.",
      );
    if (!passwordValid(password))
      throw new HttpError(
        400,
        "Use 7–18 characters with a letter and a number.",
      );
    const passcode = b.passcode || "";
    if (passcode && !passcodeValid(passcode))
      throw new HttpError(
        400,
        "Recovery passcodes need exactly 8 lowercase letters or numbers.",
      );
    const u = {
      id: crypto.randomUUID(),
      username,
      recoveryEnabled: !!passcode,
    };
    const [p, r] = await Promise.all([
      hashPassword(password),
      passcode ? hashPassword(passcode) : Promise.resolve(null),
    ]);
    try {
      await env.DB.prepare("INSERT INTO users VALUES(?,?,?,?,?)")
        .bind(u.id, username, p, r, Date.now())
        .run();
    } catch (e) {
      if (String(e).includes("UNIQUE"))
        throw new HttpError(409, "That username is already taken.");
      throw e;
    }
    return newSession(env, u, p);
  }
  if (path === "auth/signin") {
    const username = textValue(b.username, 24, "Username");
    await rateLimit(
      env,
      `signin:user:${username.toLowerCase()}`,
      15,
      15 * 60000,
    );
    const r = await env.DB.prepare("SELECT * FROM users WHERE username=?")
      .bind(username)
      .first<{
        id: string;
        username: string;
        password_hash: string;
        recovery_hash: string | null;
      }>();
    const valid = await verifyPassword(
      typeof b.password === "string" ? b.password : "",
      r?.password_hash || dummyHash,
    );
    if (!r || !valid)
      throw new HttpError(401, "The username or password is incorrect.");
    return newSession(
      env,
      { id: r.id, username: r.username, recoveryEnabled: !!r.recovery_hash },
      r.password_hash,
    );
  }
  if (path === "auth/recovery/verify" || path === "auth/recovery") {
    const username = textValue(b.username, 24, "Username");
    await rateLimit(
      env,
      `recovery:user:${username.toLowerCase()}`,
      5,
      60 * 60000,
    );
    const r = await env.DB.prepare(
      "SELECT id,recovery_hash FROM users WHERE username=?",
    )
      .bind(username)
      .first<{ id: string; recovery_hash: string | null }>();
    const valid = await verifyPassword(
      typeof b.passcode === "string" ? b.passcode : "",
      r?.recovery_hash || dummyHash,
    );
    if (!r?.recovery_hash || !valid)
      throw new HttpError(401, "Recovery details could not be verified.");
    const ticket = randomToken();
    const issued = await env.DB.prepare(
      "INSERT INTO recovery_tickets SELECT ?,id,?,0 FROM users WHERE id=? AND recovery_hash=?",
    )
      .bind(
        await digest(ticket),
        Date.now() + 10 * 60000,
        r.id,
        r.recovery_hash,
      )
      .run();
    if (!issued.meta.changes)
      throw new HttpError(401, "Recovery details could not be verified.");
    if (path === "auth/recovery/verify")
      return json({ ticket, expiresIn: 600 });
    b.ticket = ticket;
  }
  if (path === "auth/recovery" || path === "auth/recovery/reset") {
    if (typeof b.password !== "string" || !passwordValid(b.password))
      throw new HttpError(
        400,
        "Use 7–18 characters with a letter and a number.",
      );
    const th = await digest(typeof b.ticket === "string" ? b.ticket : "");
    const t = await env.DB.prepare(
      "SELECT * FROM recovery_tickets WHERE token_hash=? AND used=0 AND expires_at>?",
    )
      .bind(th, Date.now())
      .first<{ user_id: string }>();
    if (!t) throw new HttpError(401, "Recovery expired. Please start again.");
    const hash = await hashPassword(b.password),
      marker = crypto.randomUUID();
    const result = await env.DB.batch([
      env.DB.prepare(
        "UPDATE recovery_tickets SET used=? WHERE token_hash=? AND used=0 AND expires_at>?",
      ).bind(marker, th, Date.now()),
      env.DB.prepare(
        "UPDATE users SET password_hash=? WHERE id=? AND EXISTS(SELECT 1 FROM recovery_tickets WHERE token_hash=? AND used=?)",
      ).bind(hash, t.user_id, th, marker),
      env.DB.prepare(
        "DELETE FROM sessions WHERE user_id=? AND EXISTS(SELECT 1 FROM recovery_tickets WHERE token_hash=? AND used=?)",
      ).bind(t.user_id, th, marker),
      env.DB.prepare(
        "DELETE FROM recovery_tickets WHERE user_id=? AND EXISTS(SELECT 1 FROM recovery_tickets WHERE token_hash=? AND used=?)",
      ).bind(t.user_id, th, marker),
    ]);
    if (!result[0].meta.changes)
      throw new HttpError(401, "Recovery expired. Please start again.");
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  if (path === "auth/security") {
    const u = await requireUser(request, env),
      r = await env.DB.prepare("SELECT password_hash FROM users WHERE id=?")
        .bind(u.id)
        .first<{ password_hash: string }>();
    if (
      !r ||
      !(await verifyPassword(
        typeof b.currentPassword === "string" ? b.currentPassword : "",
        r.password_hash,
      ))
    )
      throw new HttpError(401, "Your current password is incorrect.");
    if (
      b.password !== undefined &&
      (typeof b.password !== "string" || !passwordValid(b.password))
    )
      throw new HttpError(
        400,
        "Use 7–18 characters with a letter and a number.",
      );
    if (b.passcode && !passcodeValid(b.passcode))
      throw new HttpError(
        400,
        "Recovery passcodes need exactly 8 lowercase letters or numbers.",
      );
    if (!b.password && !b.passcode && !b.removePasscode)
      throw new HttpError(
        400,
        "Choose a password or recovery passcode to update.",
      );
    const nextHash = b.password
      ? await hashPassword(b.password)
      : r.password_hash;
    const s: D1PreparedStatement[] = [];
    if (b.password) {
      s.push(
        env.DB.prepare(
          "UPDATE users SET password_hash=? WHERE id=? AND password_hash=?",
        ).bind(nextHash, u.id, r.password_hash),
      );
      s.push(
        env.DB.prepare(
          "INSERT INTO password_changes SELECT ?,id,? FROM users WHERE id=? AND password_hash=?",
        ).bind(crypto.randomUUID(), Date.now(), u.id, nextHash),
      );
      s.push(
        env.DB.prepare(
          "DELETE FROM sessions WHERE user_id=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND password_hash=?)",
        ).bind(u.id, u.id, nextHash),
      );
    }
    if (b.passcode || b.removePasscode)
      s.push(
        env.DB.prepare(
          "UPDATE users SET recovery_hash=? WHERE id=? AND password_hash=?",
        ).bind(
          b.removePasscode ? null : await hashPassword(b.passcode),
          u.id,
          nextHash,
        ),
      );
    s.push(
      env.DB.prepare(
        "DELETE FROM recovery_tickets WHERE user_id=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND password_hash=?)",
      ).bind(u.id, u.id, nextHash),
    );
    try {
      const result = await env.DB.batch(s);
      if (!result[0].meta.changes)
        throw new HttpError(
          409,
          "Your password changed. Please sign in again.",
        );
    } catch (e) {
      if (String(e).includes("Password change limit"))
        throw new HttpError(
          429,
          "You can change your password four times in 24 hours.",
        );
      throw e;
    }
    return json(
      { ok: true, signedOut: !!b.password },
      200,
      b.password ? { "Set-Cookie": sessionCookie("", 0) } : {},
    );
  }
  throw new HttpError(404, "Page not found.");
}
