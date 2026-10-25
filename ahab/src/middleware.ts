import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import { getUser } from "./lib/auth";
import type { AhabEnv } from "./lib/types";
export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  context.locals.user = null;
  if (/^\/(studio|library|purchases|profile|security)(\/|$)/.test(path)) {
    context.locals.user = await getUser(
      context.request,
      env as unknown as AhabEnv,
    );
    if (!context.locals.user)
      return context.redirect("/signin?next=" + encodeURIComponent(path));
  }
  const response = await next();
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  if (context.request.url.startsWith("https:"))
    response.headers.set("Strict-Transport-Security", "max-age=31536000");
  if (
    path.startsWith("/api/") ||
    /^\/(studio|library|purchases|profile|security|signin|signup|recovery)/.test(
      path,
    )
  )
    response.headers.set("Cache-Control", "private, no-store");
  return response;
});
