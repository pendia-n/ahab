import assert from "node:assert/strict";
import { afterEach, mock, test, type TestContext } from "node:test";
import {
  authRoute,
  getUser,
  requestToken,
  sessionCookie,
} from "../src/lib/auth";
import {
  base64url,
  hashPassword,
  signJwt,
  verifyJwt,
  verifyPassword,
} from "../src/lib/crypto";
import { assertMutation, HttpError } from "../src/lib/http";
import {
  DAY,
  passcodeValid,
  passwordValid,
  SESSION_SECONDS,
  usernameValid,
} from "../src/lib/policy";
import { fixture } from "./helpers";

afterEach(() => mock.restoreAll());
function setup(t: TestContext) {
  const f = fixture();
  t.after(() => f.close());
  return f;
}
function request(path: string, data: unknown = {}, cookie?: string) {
  return new Request(`https://ahab.example/api/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://ahab.example",
      "X-Ahab-Request": "1",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(data),
  });
}
function cookie(response: Response) {
  return response.headers.get("set-cookie")!.split(";")[0];
}
async function signUp(
  env: ReturnType<typeof fixture>["env"],
  username = "CreatorA",
  passcode?: string,
) {
  return authRoute(
    "auth/signup",
    request("auth/signup", {
      username,
      password: "Password1",
      ...(passcode ? { passcode } : {}),
    }),
    env,
  );
}
async function signIn(
  env: ReturnType<typeof fixture>["env"],
  password = "Password1",
  username = "CreatorA",
) {
  return authRoute(
    "auth/signin",
    request("auth/signin", { username, password }),
    env,
  );
}

test("passwords and recovery codes follow the approved bounds", () => {
  assert.equal(passwordValid("abc1234"), true);
  assert.equal(passwordValid("abcdef1".padEnd(18, "a")), true);
  for (const value of [
    "abc123",
    "allletters",
    "12345678",
    "abc1234".padEnd(19, "a"),
  ])
    assert.equal(passwordValid(value), false);
  assert.equal(passcodeValid("abc123xy"), true);
  for (const value of ["ABC123xy", "abc123x", "abc123xyz", "ab!123xy"])
    assert.equal(passcodeValid(value), false);
  assert.equal(usernameValid("creator_01"), true);
  for (const value of ["ab", "contains space", "x".repeat(25)])
    assert.equal(usernameValid(value), false);
});

test("PBKDF2 hashes are versioned, individually salted and verify without keeping plaintext", async () => {
  const [a, b] = await Promise.all([
    hashPassword("Password1"),
    hashPassword("Password1"),
  ]);
  assert.match(a, /^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.notEqual(a, b);
  assert.equal(a.includes("Password1"), false);
  assert.equal(await verifyPassword("Password1", a), true);
  assert.equal(await verifyPassword("WrongPassword2", a), false);
  assert.equal(
    await verifyPassword("Password1", "pbkdf2-sha256$1$bad$bad"),
    false,
  );
});

test("signup creates a 270-day HttpOnly secure host-only cookie and optional recovery remains off", async (t) => {
  const { db, env } = setup(t);
  const response = await signUp(env);
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie")!;
  assert.match(setCookie, /^__Host-ahab=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, new RegExp(`Max-Age=${270 * 86400}`));
  assert.equal(/domain=/i.test(setCookie), false);
  const body = (await response.json()) as {
    user: { recoveryEnabled: boolean };
  };
  assert.equal(body.user.recoveryEnabled, false);
  assert.equal(
    db.row<{ recovery_hash: string | null }>("SELECT recovery_hash FROM users")!
      .recovery_hash,
    null,
  );
  const claims = (await verifyJwt(
    requestToken(
      new Request("https://ahab.example", {
        headers: { Cookie: cookie(response) },
      }),
    ),
    env.AHAB_JWT_SECRET,
  )) as { exp: number; iat: number } | null;
  assert.ok(claims);
  assert.equal(claims.exp - claims.iat, SESSION_SECONDS);
  const session = db.row<{ expires_at: number }>(
    "SELECT expires_at FROM sessions",
  )!;
  assert.equal(session.expires_at, claims.exp * 1000);
});

test("usernames are case-insensitive for uniqueness, availability and sign-in", async (t) => {
  const { env } = setup(t);
  await signUp(env);
  await assert.rejects(
    signUp(env, "creatora"),
    (e: unknown) => e instanceof HttpError && e.status === 409,
  );
  const availability = await authRoute(
    "auth/username",
    new Request("https://ahab.example/api/auth/username?username=CREATORA"),
    env,
  );
  assert.equal(
    ((await availability.json()) as { available: boolean }).available,
    false,
  );
  const signedIn = await signIn(env, "Password1", "cReAtOrA");
  assert.equal(
    ((await signedIn.json()) as { user: { username: string } }).user.username,
    "CreatorA",
  );
});

test("JWT signature, issuer, audience and expiry are verified before a live D1 session is trusted", async (t) => {
  const { env, db } = setup(t);
  const response = await signUp(env);
  const browserRequest = new Request("https://ahab.example/api/auth/me", {
    headers: { Cookie: cookie(response) },
  });
  const token = requestToken(browserRequest);
  const user = await getUser(browserRequest, env);
  assert.ok(user);
  const [head, body, signature] = token.split(".");
  const tampered = `${head}.${base64url(new TextEncoder().encode(JSON.stringify({ sub: user.id, sid: "forged", exp: 9999999999, iss: "ahab", aud: "ahab" })))}.${signature}`;
  assert.equal(await verifyJwt(tampered, env.AHAB_JWT_SECRET), null);
  assert.equal(
    await verifyJwt(token, "another-test-signing-value-no-production-use"),
    null,
  );
  assert.equal(
    await verifyJwt(`${head}.${body}.invalid.extra`, env.AHAB_JWT_SECRET),
    null,
  );
  for (const extra of [
    { iss: "other" },
    { aud: "other" },
    { exp: Math.floor(Date.now() / 1000) - 1 },
  ]) {
    const signed = await signJwt(
      {
        sub: user.id,
        sid: "fixture",
        exp: Math.floor(Date.now() / 1000) + 100,
        iss: "ahab",
        aud: "ahab",
        ...extra,
      },
      env.AHAB_JWT_SECRET,
    );
    assert.equal(await verifyJwt(signed, env.AHAB_JWT_SECRET), null);
  }
  assert.ok(
    await getUser(
      new Request("https://ahab.example/api/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    ),
  );
  await db.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id).run();
  assert.ok(await verifyJwt(token, env.AHAB_JWT_SECRET));
  assert.equal(await getUser(browserRequest, env), null);
});

test("logout revokes the current D1 session and clears its cookie", async (t) => {
  const { env } = setup(t);
  const response = await signUp(env);
  const oldCookie = cookie(response);
  const logout = await authRoute(
    "auth/logout",
    request("auth/logout", {}, oldCookie),
    env,
  );
  assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal(
    await getUser(
      new Request("https://ahab.example", { headers: { Cookie: oldCookie } }),
      env,
    ),
    null,
  );
});

test("skipping recovery prevents logged-out reset and returns the same failure as an unknown account", async (t) => {
  const { env } = setup(t);
  await signUp(env);
  const errors: HttpError[] = [];
  for (const username of ["CreatorA", "UnknownCreator"]) {
    try {
      await authRoute(
        "auth/recovery/verify",
        request("auth/recovery/verify", { username, passcode: "abc123xy" }),
        env,
      );
    } catch (error) {
      assert.ok(error instanceof HttpError);
      errors.push(error);
    }
  }
  assert.equal(errors.length, 2);
  assert.equal(errors[0].status, 401);
  assert.equal(errors[0].message, errors[1].message);
});

test("recovery tickets expire after ten minutes, are single-use and revoke every existing session", async (t) => {
  const { env, db } = setup(t);
  const initial = await signUp(env, "CreatorA", "abc123xy");
  const second = await signIn(env);
  assert.equal(
    db.row<{ n: number }>("SELECT count(*) AS n FROM sessions")!.n,
    2,
  );
  const verified = await authRoute(
    "auth/recovery/verify",
    request("auth/recovery/verify", {
      username: "CreatorA",
      passcode: "abc123xy",
    }),
    env,
  );
  const { ticket, expiresIn } = (await verified.json()) as {
    ticket: string;
    expiresIn: number;
  };
  assert.equal(expiresIn, 600);
  const now = Date.now();
  mock.method(Date, "now", () => now + 601000);
  await assert.rejects(
    authRoute(
      "auth/recovery/reset",
      request("auth/recovery/reset", { ticket, password: "ChangedPassword2" }),
      env,
    ),
    (e: unknown) => e instanceof HttpError && e.status === 401,
  );
  mock.restoreAll();
  const fresh = await authRoute(
    "auth/recovery/verify",
    request("auth/recovery/verify", {
      username: "CreatorA",
      passcode: "abc123xy",
    }),
    env,
  );
  const freshTicket = ((await fresh.json()) as { ticket: string }).ticket;
  await authRoute(
    "auth/recovery/reset",
    request("auth/recovery/reset", {
      ticket: freshTicket,
      password: "ChangedPassword2",
    }),
    env,
  );
  assert.equal(
    db.row<{ n: number }>("SELECT count(*) AS n FROM sessions")!.n,
    0,
  );
  for (const oldCookie of [cookie(initial), cookie(second)])
    assert.equal(
      await getUser(
        new Request("https://ahab.example", { headers: { Cookie: oldCookie } }),
        env,
      ),
      null,
    );
  await assert.rejects(
    authRoute(
      "auth/recovery/reset",
      request("auth/recovery/reset", {
        ticket: freshTicket,
        password: "AnotherPassword3",
      }),
      env,
    ),
    (e: unknown) => e instanceof HttpError && e.status === 401,
  );
  assert.equal((await signIn(env, "ChangedPassword2")).status, 200);
  await assert.rejects(
    signIn(env, "Password1"),
    (e: unknown) => e instanceof HttpError && e.status === 401,
  );
});

test("authenticated password changes allow four successful changes per rolling day and revoke sessions", async (t) => {
  const { env, db } = setup(t);
  let response = await signUp(env);
  let password = "Password1";
  for (let i = 0; i < 4; i++) {
    if (i > 0) response = await signIn(env, password);
    const oldCookie = cookie(response);
    const next = `Password${i + 2}`;
    const changed = await authRoute(
      "auth/security",
      request(
        "auth/security",
        { currentPassword: password, password: next },
        oldCookie,
      ),
      env,
    );
    assert.equal(
      ((await changed.json()) as { signedOut: boolean }).signedOut,
      true,
    );
    assert.match(changed.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal(
      await getUser(
        new Request("https://ahab.example", { headers: { Cookie: oldCookie } }),
        env,
      ),
      null,
    );
    password = next;
  }
  const fifth = await signIn(env, password);
  await assert.rejects(
    authRoute(
      "auth/security",
      request(
        "auth/security",
        { currentPassword: password, password: "Password6" },
        cookie(fifth),
      ),
      env,
    ),
    (e: unknown) => e instanceof HttpError && e.status === 429,
  );
  assert.equal(
    db.row<{ n: number }>("SELECT count(*) AS n FROM password_changes")!.n,
    4,
  );
  assert.equal(
    await verifyPassword(
      password,
      db.row<{ password_hash: string }>("SELECT password_hash FROM users")!
        .password_hash,
    ),
    true,
  );
  assert.ok(
    await getUser(
      new Request("https://ahab.example", {
        headers: { Cookie: cookie(fifth) },
      }),
      env,
    ),
  );
  const nextDay = Date.now() + DAY + 1;
  mock.method(Date, "now", () => nextDay);
  assert.equal(
    (
      await authRoute(
        "auth/security",
        request(
          "auth/security",
          { currentPassword: password, password: "Password6" },
          cookie(fifth),
        ),
        env,
      )
    ).status,
    200,
  );
});

test("recovery attempts are limited even when the username does not exist", async (t) => {
  const { env } = setup(t);
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      authRoute(
        "auth/recovery/verify",
        request("auth/recovery/verify", {
          username: "UnknownCreator",
          passcode: "abc123xy",
        }),
        env,
      ),
      (e: unknown) => e instanceof HttpError && e.status === 401,
    );
  await assert.rejects(
    authRoute(
      "auth/recovery/verify",
      request("auth/recovery/verify", {
        username: "UnknownCreator",
        passcode: "abc123xy",
      }),
      env,
    ),
    (e: unknown) => e instanceof HttpError && e.status === 429,
  );
});

test("browser mutations require same-origin proof while API clients can use bearer authorization", () => {
  assert.doesNotThrow(() => assertMutation(request("auth/logout")));
  const requests: Record<string, string>[] = [
    { Origin: "https://other.example", "X-Ahab-Request": "1" },
    { Origin: "https://ahab.example" },
    { "X-Ahab-Request": "1" },
  ];
  for (const headers of requests) {
    assert.throws(
      () =>
        assertMutation(
          new Request("https://ahab.example/api/auth/logout", {
            method: "POST",
            headers,
          }),
        ),
      (e: unknown) => e instanceof HttpError && e.status === 403,
    );
  }
  assert.doesNotThrow(() =>
    assertMutation(
      new Request("https://ahab.example/api/jobs", {
        method: "POST",
        headers: { Authorization: "Bearer fixture-token" },
      }),
    ),
  );
  assert.match(sessionCookie("fixture"), /HttpOnly; Secure; SameSite=Lax/);
});
