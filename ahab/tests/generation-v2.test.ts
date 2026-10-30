import assert from "node:assert/strict";
import { test, mock, afterEach } from "node:test";
import { fixture, seedUser } from "./helpers";
import { createGeneration } from "../src/lib/generation";
import { saveAsset } from "../src/lib/media";
import { prepare } from "../src/lib/preparation";
import { inspectMp4Metadata } from "../src/lib/output-validation";
afterEach(() => mock.restoreAll());
async function setup() {
  const f = fixture();
  await seedUser(f.db);
  await f.db
    .prepare(
      "INSERT INTO purchases(id,user_id,package_id,amount_cents,created_at) VALUES('p','user-a','allowance_v2',500,?)",
    )
    .bind(Date.now())
    .run();
  await f.db.prepare("INSERT INTO purchase_items VALUES('p','p','{}',2)").run();
  await f.db
    .prepare(
      "INSERT INTO allowances(id,user_id,package_id,videos_remaining,portraits_remaining,max_duration,created_at,service,resolution,generated_capacity,task_type) VALUES('p','user-a','allowance_v2',2,2,15,?,'scene','1080p',15,'demo')",
    )
    .bind(Date.now())
    .run();
  await f.media.put("face-key", "fixture-image");
  await saveAsset(f.env, {
    id: "face",
    user_id: "user-a",
    kind: "image",
    r2_key: "face-key",
    name: "Product.jpg",
    mime: "image/jpeg",
    bytes: 13,
    duration: null,
    width: 540,
    height: 960,
  });
  return {
    ...f,
    env: {
      ...f.env,
      GENERATION_ENABLED: "true",
      OPENROUTER_API_KEY: "fixture-only",
    },
  };
}
const request = (body: any) =>
  new Request("https://ahab.example/api/generate", {
    method: "POST",
    body: JSON.stringify(body),
  });
const input = {
  allowanceId: "p",
  requestKey: "repeat-request-123",
  taskType: "demo",
  service: "scene",
  duration: 15,
  resolution: "1080p",
  prompt: "Demonstrate this product. No invented claims.",
  script: "",
  imageIds: ["face"],
  approved: true,
};
test("a retry with the same request key returns the durable job without spending twice", async () => {
  const f = await setup();
  try {
    const a = await createGeneration(request(input), f.env, "user-a", "video");
    const b = await createGeneration(request(input), f.env, "user-a", "video");
    assert.equal(
      ((await a.json()) as any).job.id,
      ((await b.json()) as any).job.id,
    );
    assert.equal(
      f.db.row<any>("SELECT videos_remaining FROM allowances WHERE id='p'")!
        .videos_remaining,
      1,
    );
    assert.equal(f.db.rows("SELECT * FROM jobs").length, 1);
  } finally {
    f.close();
  }
});
test("concurrent scene requests cannot overdraw a new allowance", async () => {
  const f = await setup();
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        createGeneration(
          request({ ...input, requestKey: "parallel-request-" + i }),
          f.env,
          "user-a",
          "video",
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
    assert.equal(
      f.db.row<any>("SELECT videos_remaining FROM allowances WHERE id='p'")!
        .videos_remaining,
      0,
    );
    assert.equal(f.db.rows("SELECT * FROM jobs").length, 2);
  } finally {
    f.close();
  }
});
test("unsupported references, incompatible bonus capacity and missing approval do not reserve allowances", async () => {
  const f = await setup();
  try {
    for (const patch of [
      { videoId: "video" },
      { approved: false },
      { taskType: "reaction", duration: 5, resolution: "720p" },
      { imageIds: [] },
    ])
      await assert.rejects(
        createGeneration(
          request({ ...input, ...patch }),
          f.env,
          "user-a",
          "video",
        ),
      );
    assert.equal(f.db.rows("SELECT * FROM jobs").length, 0);
    assert.equal(
      f.db.row<any>("SELECT videos_remaining FROM allowances WHERE id='p'")!
        .videos_remaining,
      2,
    );
  } finally {
    f.close();
  }
});
test("writing assistance preserves exact dialogue and is bounded and idempotent", async () => {
  const f = await setup();
  try {
    let calls = 0;
    mock.method(globalThis, "fetch", async () => {
      calls++;
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                script: "An unapproved rewrite",
                direction: "Show the product on a table.",
                shots: ["Presenter opening", "Product detail"],
              }),
            },
          },
        ],
        usage: { cost: 0.001 },
      });
    });
    const body = {
      ...input,
      prompt: "The original user brief",
      wording: "exact",
      script: "EXACT dialogue, unchanged.",
    };
    const a = await prepare(request(body), f.env, "user-a");
    const b = await prepare(request(body), f.env, "user-a");
    assert.equal(((await a.json()) as any).preparation.script, body.script);
    assert.equal(((await b.json()) as any).preparation.script, body.script);
    assert.equal(calls, 1);
    assert.equal(
      f.db.row<any>("SELECT text_used FROM allowances WHERE id='p'")!.text_used,
      1,
    );
    for (let i = 1; i < 6; i++)
      await prepare(
        request({ ...body, requestKey: "text-revision-" + i }),
        f.env,
        "user-a",
      );
    await assert.rejects(
      prepare(
        request({ ...body, requestKey: "text-revision-7" }),
        f.env,
        "user-a",
      ),
      /preparation remaining/,
    );
    assert.equal(calls, 6);
  } finally {
    f.close();
  }
});
function box(type: string, payload: Uint8Array) {
  const b = new Uint8Array(8 + payload.length);
  new DataView(b.buffer).setUint32(0, b.length);
  b.set(new TextEncoder().encode(type), 4);
  b.set(payload, 8);
  return b;
}
function concat(...a: Uint8Array[]) {
  const b = new Uint8Array(a.reduce((s, v) => s + v.length, 0));
  let n = 0;
  for (const v of a) {
    b.set(v, n);
    n += v.length;
  }
  return b;
}
test("MP4 inspection reads actual time, dimensions and audio instead of inventing output metadata", () => {
  const movie = new Uint8Array(20);
  const m = new DataView(movie.buffer);
  m.setUint32(12, 1000);
  m.setUint32(16, 15000);
  const tk = new Uint8Array(84),
    v = new DataView(tk.buffer);
  v.setUint32(76, 1080 * 65536);
  v.setUint32(80, 1920 * 65536);
  const handler = (kind: string) => {
    const b = new Uint8Array(12);
    b.set(new TextEncoder().encode(kind), 8);
    return box("mdia", box("hdlr", b));
  };
  const bytes = box(
    "moov",
    concat(
      box("mvhd", movie),
      box("trak", concat(box("tkhd", tk), handler("vide"))),
      box("trak", handler("soun")),
    ),
  );
  assert.deepEqual(inspectMp4Metadata(bytes), {
    duration: 15,
    width: 1080,
    height: 1920,
    hasAudio: true,
  });
  assert.throws(() => inspectMp4Metadata(new Uint8Array(100)));
});
