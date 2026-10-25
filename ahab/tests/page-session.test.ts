import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./helpers";
import { authRoute } from "../src/lib/auth";
import { pageSession } from "../src/lib/page-session";

async function login(env: ReturnType<typeof fixture>["env"]) {
  const response = await authRoute(
    "auth/signup",
    new Request("https://ahab.example/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        username: "NavigationUser",
        password: "Password1",
      }),
    }),
    env,
  );
  return response.headers.get("set-cookie")!.split(";")[0];
}
const publicPages = [
  "/",
  "/pricing",
  "/about",
  "/announcements",
  "/privacy",
  "/terms",
];
const privatePages = [
  "/studio",
  "/library",
  "/purchases",
  "/profile",
  "/security",
];
test("every public and private page receives the signed-in user before rendering", async () => {
  const f = fixture();
  try {
    const cookie = await login(f.env);
    for (const path of [...publicPages, ...privatePages]) {
      const state = await pageSession(
        new Request("https://ahab.example" + path, {
          headers: { Cookie: cookie },
        }),
        f.env,
      );
      assert.equal(state.user?.username, "NavigationUser", path);
      assert.equal(state.redirect, null, path);
      assert.equal(state.sessionAware, true, path);
    }
  } finally {
    f.close();
  }
});
test("signed-in users cannot access sign-in, sign-up or recovery forms, including trailing slashes", async () => {
  const f = fixture();
  try {
    const cookie = await login(f.env);
    for (const path of [
      "/signin",
      "/signup",
      "/recovery",
      "/signin/",
      "/signup/?next=%2Fpurchases",
      "/recovery/",
    ]) {
      const state = await pageSession(
        new Request("https://ahab.example" + path, {
          headers: { Cookie: cookie },
        }),
        f.env,
      );
      assert.equal(state.redirect, "/studio", path);
    }
  } finally {
    f.close();
  }
});
test("guests can read public/auth pages and private redirects preserve query strings", async () => {
  const f = fixture();
  try {
    for (const path of [...publicPages, "/signin", "/signup", "/recovery"])
      assert.equal(
        (await pageSession(new Request("https://ahab.example" + path), f.env))
          .redirect,
        null,
        path,
      );
    for (const path of privatePages)
      assert.equal(
        (
          await pageSession(
            new Request("https://ahab.example" + path + "?image=reference"),
            f.env,
          )
        ).redirect,
        "/signin?next=" + encodeURIComponent(path + "?image=reference"),
        path,
      );
  } finally {
    f.close();
  }
});
test("revoked and invalid sessions cannot render authenticated navigation; offline/API remain independent", async () => {
  const f = fixture();
  try {
    const cookie = await login(f.env);
    await f.db.prepare("DELETE FROM sessions").run();
    for (const value of [cookie, "__Host-ahab=invalid"]) {
      const state = await pageSession(
        new Request("https://ahab.example/", { headers: { Cookie: value } }),
        f.env,
      );
      assert.equal(state.user, null);
    }
    for (const path of ["/offline", "/api/auth/me"])
      assert.equal(
        (await pageSession(new Request("https://ahab.example" + path), f.env))
          .sessionAware,
        false,
      );
  } finally {
    f.close();
  }
});
