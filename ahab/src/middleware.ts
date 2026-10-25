import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import { pageSession } from "./lib/page-session";
import type { AhabEnv } from "./lib/types";
export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  const session = await pageSession(context.request, env as unknown as AhabEnv);
  context.locals.user = session.user;
  const response = session.redirect
    ? context.redirect(session.redirect)
    : await next();
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  if (context.request.url.startsWith("https:"))
    response.headers.set("Strict-Transport-Security", "max-age=31536000");
  if (path.startsWith("/api/") || session.sessionAware)
    response.headers.set("Cache-Control", "private, no-store");
  if (session.sessionAware) {
    const vary = new Set(
      (response.headers.get("Vary") || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    );
    vary.add("Cookie");
    vary.add("Authorization");
    response.headers.set("Vary", [...vary].join(", "));
  }
  return response;
});
