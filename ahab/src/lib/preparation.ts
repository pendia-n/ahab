import type { AhabEnv } from "./types";
import { HttpError, json, readJson, textValue } from "./http";
import { prepareText, OpenRouterError } from "./openrouter";
import { taskById } from "./offers";
import { savePrompt } from "./media";
const FORMAT_DIRECTION: Record<string, string> = {
  presenter:
    "One person speaking directly to the viewer. A clear opening, one idea and a relevant next step. Do not request product handling or separate scene overlays.",
  demo: "Show the action and the useful outcome. Use product details as visual evidence; explain only what is provided.",
  unboxing:
    "Establish the package, reveal the contents and show a useful detail. Preserve packaging and product identity.",
  reaction:
    "A clearly performed discovery or surprise. Connect the reaction to the supplied product facts; never invent a real customer testimonial.",
  showcase:
    "Let product details and everyday context carry the message. Keep dialogue minimal and every cutaway relevant.",
  explainer:
    "State a recognizable problem, explain one solution and give a clear next step. Presenter shots establish connection; scene cutaways illustrate the explanation.",
};
export async function prepare(request: Request, env: AhabEnv, userId: string) {
  if (env.GENERATION_ENABLED !== "true" || !env.OPENROUTER_API_KEY)
    throw new HttpError(503, "Preparation is temporarily unavailable.");
  const b = await readJson(request),
    raw = textValue(b.prompt, 6000, "Your brief");
  if (
    !taskById(b.taskType) ||
    !["exact", "polish", "draft"].includes(b.wording) ||
    !Number.isInteger(b.duration) ||
    b.duration < 5 ||
    b.duration > 121
  )
    throw new HttpError(400, "Choose a format, duration and writing option.");
  if (
    typeof b.requestKey !== "string" ||
    !/^[a-zA-Z0-9_-]{12,100}$/.test(b.requestKey)
  )
    throw new HttpError(400, "Refresh the studio and try again.");
  const old = await env.DB.prepare(
    "SELECT status,result_json FROM preparations WHERE user_id=? AND request_key=?",
  )
    .bind(userId, b.requestKey)
    .first<{ status: string; result_json: string | null }>();
  if (old) {
    if (old.result_json)
      return json({ preparation: JSON.parse(old.result_json) });
    throw new HttpError(409, "This preparation is already being checked.");
  }
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      "INSERT INTO preparations(id,user_id,allowance_id,request_key,raw_text,status,created_at) VALUES(?,?,?,?,?,'submitting',?)",
    )
      .bind(id, userId, b.allowanceId, b.requestKey, raw, Date.now())
      .run();
  } catch {
    throw new HttpError(
      409,
      "Choose an allowance with a text preparation remaining.",
    );
  }
  await savePrompt(
    env,
    userId,
    typeof b.userPrompt === "string" && b.userPrompt.trim()
      ? b.userPrompt
      : raw,
  ).catch(() => {});
  try {
    const r = await prepareText(env, {
      raw,
      script: typeof b.script === "string" ? b.script.slice(0, 12000) : "",
      style:
        typeof b.style === "string"
          ? b.style.slice(0, 200)
          : "Natural and conversational",
      task: `${b.taskType}: ${FORMAT_DIRECTION[b.taskType]}`,
      duration: b.duration,
      wording: b.wording,
    });
    const result = {
      id,
      script: r.script,
      direction: r.direction,
      shots: r.shots,
    };
    await env.DB.prepare(
      "UPDATE preparations SET status='completed',result_json=?,raw_text='',actual_cents=? WHERE id=?",
    )
      .bind(
        JSON.stringify(result),
        r.costUsd === null ? null : Math.ceil(r.costUsd * 100),
        id,
      )
      .run();
    return json({ preparation: result });
  } catch (e) {
    const uncertain = e instanceof OpenRouterError && e.submissionUncertain;
    const statements = [
      env.DB.prepare(
        "UPDATE preparations SET status=?,raw_text=? WHERE id=?",
      ).bind(uncertain ? "uncertain" : "failed", "", id),
    ];
    if (!uncertain)
      statements.push(
        env.DB.prepare(
          "UPDATE allowances SET text_used=MAX(0,text_used-1) WHERE id=? AND user_id=?",
        ).bind(b.allowanceId, userId),
      );
    await env.DB.batch(statements);
    throw new HttpError(
      502,
      uncertain
        ? "Preparation needs a status check. It will not be submitted twice."
        : "Preparation could not finish. Your text preparation has been restored.",
    );
  }
}
