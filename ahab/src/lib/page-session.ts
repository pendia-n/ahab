import { getUser } from "./auth";
import type { AhabEnv } from "./types";

export async function pageSession(request: Request, env: AhabEnv) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const protectedPage =
    /^\/(studio|library|purchases|profile|security)(\/|$)/.test(path);
  const sessionAware = path !== "/offline" && !path.startsWith("/api/");
  const user = sessionAware ? await getUser(request, env) : null;
  const guestPage = ["/signin", "/signup", "/recovery"].includes(path);
  const redirect =
    protectedPage && !user
      ? "/signin?next=" + encodeURIComponent(path + url.search)
      : guestPage && user
        ? "/studio"
        : null;
  return { user, redirect, sessionAware };
}
