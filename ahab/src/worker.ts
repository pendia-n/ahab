import { handle } from "@astrojs/cloudflare/handler";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { AhabEnv, JobRow } from "./lib/types";
import { jobById, jobRequest } from "./lib/generation";
import {
  submitVideo,
  pollVideo,
  downloadVideo,
  generatePortrait,
  OpenRouterError,
} from "./lib/openrouter";
import { assetStatement, expireMedia } from "./lib/media";
const terminal = (j: JobRow) => ["completed", "failed"].includes(j.status);
const cents = (value: number | null) =>
  value === null ? null : Math.ceil(value * 100);
async function uncertain(env: AhabEnv, id: string) {
  await env.DB.prepare(
    "UPDATE jobs SET status='uncertain',error=?,updated_at=? WHERE id=? AND status NOT IN ('completed','failed')",
  )
    .bind(
      "This request needs a provider status check. Its allowance is held to avoid a duplicate charge.",
      Date.now(),
      id,
    )
    .run();
}
async function failed(
  env: AhabEnv,
  id: string,
  error: string,
  cost: number | null = 0,
) {
  await env.DB.prepare(
    "UPDATE jobs SET status='failed',error=?,actual_cents=COALESCE(?,actual_cents,CASE WHEN provider_id IS NOT NULL THEN estimate_cents ELSE 0 END),updated_at=? WHERE id=? AND status NOT IN ('completed','failed')",
  )
    .bind(error, cost, Date.now(), id)
    .run();
}
export class GenerationWorkflow extends WorkflowEntrypoint<
  AhabEnv,
  { jobId: string }
> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep) {
    const id = event.payload.jobId;
    const initial = await step.do("load durable job", () =>
      jobById(this.env, id),
    );
    if (!initial || terminal(initial)) return;
    const submit = await step.do(
      "submit once",
      { retries: { limit: 0, delay: "1 second" }, timeout: "5 minutes" },
      async () => {
        const j = await jobById(this.env, id);
        if (!j || terminal(j)) return null;
        if (j.provider_id) return j.provider_id;
        const claimed = await this.env.DB.prepare(
          "UPDATE jobs SET status='submitting',updated_at=? WHERE id=? AND status='queued' RETURNING id",
        )
          .bind(Date.now(), id)
          .first();
        if (!claimed) {
          if (j.updated_at < Date.now() - 15 * 60000)
            await uncertain(this.env, id);
          return null;
        }
        try {
          if (j.kind === "portrait") {
            const result = await generatePortrait(this.env, {
              prompt: JSON.parse(j.request_json).prompt,
            });
            const ext =
              result.mediaType === "image/jpeg"
                ? "jpg"
                : result.mediaType === "image/webp"
                  ? "webp"
                  : "png";
            const key = `inputs/${j.user_id}/${id}.${ext}`;
            await this.env.MEDIA.put(key, result.bytes, {
              httpMetadata: { contentType: result.mediaType },
            });
            await this.env.DB.batch([
              assetStatement(this.env, {
                id,
                user_id: j.user_id,
                kind: "image",
                r2_key: key,
                name: "AI portrait." + ext,
                mime: result.mediaType,
                bytes: result.bytes.byteLength,
                duration: null,
                width: null,
                height: null,
              }),
              this.env.DB.prepare(
                "UPDATE jobs SET status='completed',asset_id=?,actual_cents=?,updated_at=? WHERE id=? AND status='submitting'",
              ).bind(id, cents(result.costUsd), Date.now(), id),
            ]);
            return null;
          }
          const result = await submitVideo(
            this.env,
            await jobRequest(this.env, j),
          );
          await this.env.DB.prepare(
            "UPDATE jobs SET provider_id=?,status=?,actual_cents=?,error=NULL,updated_at=? WHERE id=? AND status NOT IN ('completed','failed')",
          )
            .bind(
              result.id,
              ["completed", "failed", "cancelled", "expired"].includes(
                result.status,
              )
                ? "in_progress"
                : result.status,
              cents(result.costUsd),
              Date.now(),
              id,
            )
            .run();
          if (["failed", "cancelled", "expired"].includes(result.status)) {
            await failed(
              this.env,
              id,
              "The provider did not complete this video. One video allowance has been restored.",
              cents(result.costUsd),
            );
            return null;
          }
          return result.id;
        } catch (e) {
          if (e instanceof OpenRouterError && !e.submissionUncertain) {
            await failed(this.env, id, e.message);

          } else await uncertain(this.env, id);
          return null;
        }
      },
    );
    if (!submit) return;
    for (let i = 0; i < 240; i++) {
      const state = await step.do(
        `poll ${i}`,
        {
          retries: { limit: 4, delay: "10 seconds", backoff: "exponential" },
          timeout: "5 minutes",
        },
        async () => {
          const j = await jobById(this.env, id);
          if (!j || terminal(j)) return "stop";
          const result = await pollVideo(this.env, submit);
          if (["failed", "cancelled", "expired"].includes(result.status)) {
            await failed(
              this.env,
              id,
              "The provider did not complete this video. One video allowance has been restored.",
              cents(result.costUsd),
            );
            return "stop";
          }
          if (result.status === "completed") {
            await this.env.DB.prepare(
              "UPDATE jobs SET status='in_progress',actual_cents=COALESCE(?,actual_cents),updated_at=? WHERE id=? AND status NOT IN ('completed','failed')",
            )
              .bind(cents(result.costUsd), Date.now(), id)
              .run();
            return "download";
          }
          await this.env.DB.prepare(
            "UPDATE jobs SET status=?,actual_cents=COALESCE(?,actual_cents),updated_at=? WHERE id=? AND status NOT IN ('completed','failed')",
          )
            .bind(result.status, cents(result.costUsd), Date.now(), id)
            .run();
          return "wait";
        },
      );
      if (state === "stop") return;
      if (state === "download") {
        await step.do(
          "save completed video",
          {
            retries: { limit: 6, delay: "20 seconds", backoff: "exponential" },
            timeout: "10 minutes",
          },
          async () => {
            const j = await jobById(this.env, id);
            if (!j || terminal(j)) return;
            const key = `outputs/${j.user_id}/${id}.mp4`,
              response = await downloadVideo(this.env, submit);
            await this.env.MEDIA.put(key, response.body!, {
              httpMetadata: { contentType: "video/mp4" },
            });
            const object = await this.env.MEDIA.head(key);
            if (!object) throw new Error("Storage verification failed.");
            await this.env.DB.batch([
              assetStatement(this.env, {
                id,
                user_id: j.user_id,
                kind: "output",
                r2_key: key,
                name: `Ahab-${id.slice(0, 8)}.mp4`,
                mime: "video/mp4",
                bytes: object.size,
                duration: j.duration,
                width: null,
                height: null,
              }),
              this.env.DB.prepare(
                "UPDATE jobs SET status='completed',asset_id=?,error=NULL,updated_at=? WHERE id=? AND status NOT IN ('completed','failed')",
              ).bind(id, Date.now(), id),
            ]);
          },
        );
        return;
      }
      await step.sleep(`wait ${i}`, "15 seconds");
    }
    await step.do("hold long running job", () => uncertain(this.env, id));
  }
}
async function scheduled(env: AhabEnv) {
  await expireMedia(env);
  await env.DB.prepare(
    "UPDATE jobs SET status='uncertain',error=?,updated_at=? WHERE status='submitting' AND provider_id IS NULL AND updated_at<?",
  )
    .bind(
      "This request needs a provider status check. Its allowance is held to avoid a duplicate charge.",
      Date.now(),
      Date.now() - 15 * 60000,
    )
    .run();
  const rows = await env.DB.prepare(
    "SELECT id,status,provider_id FROM jobs WHERE (status='queued' OR (provider_id IS NOT NULL AND status NOT IN ('completed','failed'))) AND updated_at<? LIMIT 20",
  )
    .bind(Date.now() - 15 * 60000)
    .all<{ id: string; status: string; provider_id: string | null }>();
  for (const j of rows.results) {
    try {
      await env.GENERATION.create({
        id: `reconcile-${j.id}-${Math.floor(Date.now() / 900000)}`,
        params: { jobId: j.id },
      });
    } catch {}
  }
}
export default {
  fetch(request: Request, env: AhabEnv, ctx: ExecutionContext) {
    return handle(request, env as unknown as Env, ctx);
  },
  scheduled(
    _controller: ScheduledController,
    env: AhabEnv,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(scheduled(env));
  },
};
