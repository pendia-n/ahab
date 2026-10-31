import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import type { AhabEnv } from "../../lib/types";
import { authRoute, requireUser, requestRate } from "../../lib/auth";
import { HttpError, json, assertMutation, readJson } from "../../lib/http";
import {
  library,
  upload,
  ownedAsset,
  mediaResponse,
  providerMedia,
  savePrompt,
  deleteOutbox,
} from "../../lib/media";
import { purchases, checkout, webhook, readiness } from "../../lib/payments";
import { createGeneration, jobById, publicJob } from "../../lib/generation";
import {
  createQuote,
  makeQuote,
  publicQuote,
  expressEnabled,
} from "../../lib/quotes";
import { prepare } from "../../lib/preparation";
export const prerender = false;
export const ALL: APIRoute = async ({ request, params }) => {
  const e = env as unknown as AhabEnv,
    path = (params.path || "").replace(/\/$/, ""),
    method = request.method;
  try {
    if (path === "health" && method === "GET") {
      await e.DB.prepare("SELECT 1").first();
      return json({ ok: true, service: "ahab" });
    }
    if (path === "webhooks/stripe" && method === "POST")
      return await webhook(request, e);
    const provider = /^provider\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9-]+)$/.exec(path);
    if (provider && (method === "GET" || method === "HEAD"))
      return await providerMedia(request, e, provider[1], provider[2]);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) assertMutation(request);
    if (path === "config" && method === "GET") return json(await readiness(e));
    if (path === "quote-preview" && method === "POST") {
      await requestRate(e, request, "quote-preview", 40);
      const b = await readJson(request);
      try {
        return json(publicQuote(makeQuote(b.items, expressEnabled(e))));
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
    }
    if (path.startsWith("auth/")) return await authRoute(path, request, e);
    const user = await requireUser(request, e);
    if (path === "quotes" && method === "POST") {
      await requestRate(e, request, "quote", 40);
      return await createQuote(request, e, user.id);
    }
    if (path === "prepare" && method === "POST") {
      await requestRate(e, request, "prepare", 10);
      return await prepare(request, e, user.id);
    }
    if (path === "library" && method === "GET")
      return await library(e, user.id);
    if (path === "purchases" && method === "GET")
      return await purchases(e, user.id);
    if (path === "checkout" && method === "POST") {
      await requestRate(e, request, "checkout", 10);
      return await checkout(request, e, user.id);
    }
    if (path === "media" && method === "POST") {
      await requestRate(e, request, "upload", 45);
      return await upload(request, e, user.id);
    }
    const media = /^media\/([a-zA-Z0-9-]+)$/.exec(path);
    if (media) {
      const a = await ownedAsset(e, media[1], user.id);
      if (method === "GET" || method === "HEAD")
        return await mediaResponse(request, e, a);
      if (method === "DELETE") {
        await e.DB.prepare("DELETE FROM assets WHERE id=? AND user_id=?")
          .bind(a.id, user.id)
          .run();
        await deleteOutbox(e);
        return json({ ok: true });
      }
    }
    if (path === "prompts" && method === "POST") {
      const b = await readJson(request);
      return json({ prompt: await savePrompt(e, user.id, b.text) }, 201);
    }
    const prompt = /^prompts\/([a-zA-Z0-9-]+)$/.exec(path);
    if (prompt && method === "DELETE") {
      await e.DB.prepare("DELETE FROM prompts WHERE id=? AND user_id=?")
        .bind(prompt[1], user.id)
        .run();
      return json({ ok: true });
    }
    if ((path === "generate" || path === "portraits") && method === "POST") {
      await requestRate(e, request, "generate", 12);
      return await createGeneration(
        request,
        e,
        user.id,
        path === "portraits" ? "portrait" : "video",
      );
    }
    const job = /^jobs\/([a-zA-Z0-9-]+)$/.exec(path);
    if (job && method === "GET") {
      const j = await jobById(e, job[1]);
      if (!j || j.user_id !== user.id)
        throw new HttpError(404, "Job not found.");
      return json({ job: publicJob(j) });
    }
    throw new HttpError(404, "Page not found.");
  } catch (error) {
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status);
    // Never log provider errors, signed URLs, raw requests, credentials or stack traces.
    return json(
      { error: "This action could not be completed. Please try again." },
      500,
    );
  }
};
