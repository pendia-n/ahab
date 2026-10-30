import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { AhabEnv } from "../src/lib/types";

type BindValue = string | number | bigint | null | Uint8Array;

class TestStatement {
  constructor(
    readonly owner: TestDatabase,
    readonly sql: string,
    readonly values: BindValue[] = [],
  ) {}
  bind(...values: BindValue[]) {
    return new TestStatement(this.owner, this.sql, values);
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.owner.sqlite.prepare(this.sql).get(...this.values);
    return (row ? (column ? row[column] : { ...row }) : null) as T | null;
  }
  async all<T = Record<string, unknown>>() {
    const results = this.owner.sqlite
      .prepare(this.sql)
      .all(...this.values)
      .map((row) => ({ ...row })) as T[];
    return { results, success: true, meta: { changes: 0, duration: 0 } };
  }
  async run() {
    const result = this.owner.sqlite.prepare(this.sql).run(...this.values);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
        duration: 0,
      },
    };
  }
}

/** Exercise the real migration and SQL, while matching D1's asynchronous result shape. */
export class TestDatabase {
  readonly sqlite = new DatabaseSync(":memory:");
  private batchQueue: Promise<void> = Promise.resolve();
  constructor() {
    this.sqlite.exec(
      readFileSync(
        new URL("../migrations/0001_initial.sql", import.meta.url),
        "utf8",
      ),
    );
    this.sqlite.exec(
      readFileSync(
        new URL(
          "../migrations/0002_remove_manual_funding_gate.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    this.sqlite.exec(
      readFileSync(
        new URL("../migrations/0003_task_allowances.sql", import.meta.url),
        "utf8",
      ),
    );
  }
  prepare(sql: string) {
    return new TestStatement(this, sql);
  }
  async batch(statements: TestStatement[]) {
    // D1 serializes transactions; do not interleave BEGINs on this test connection.
    const previous = this.batchQueue;
    let release!: () => void;
    this.batchQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      release();
    }
  }
  row<T = Record<string, unknown>>(
    sql: string,
    ...values: BindValue[]
  ): T | undefined {
    const row = this.sqlite.prepare(sql).get(...values);
    return row ? ({ ...row } as T) : undefined;
  }
  rows<T = Record<string, unknown>>(sql: string, ...values: BindValue[]): T[] {
    return this.sqlite
      .prepare(sql)
      .all(...values)
      .map((row) => ({ ...row })) as T[];
  }
  close() {
    this.sqlite.close();
  }
}

export class TestMedia {
  readonly objects = new Map<string, Uint8Array>();
  readonly deleted: string[] = [];
  readonly failDelete = new Set<string>();
  async put(
    key: string,
    body: ReadableStream | Uint8Array | ArrayBuffer | string,
  ) {
    const bytes =
      typeof body === "string"
        ? new TextEncoder().encode(body)
        : body instanceof Uint8Array
          ? body
          : body instanceof ArrayBuffer
            ? new Uint8Array(body)
            : new Uint8Array(await new Response(body).arrayBuffer());
    this.objects.set(key, bytes);
    return { key, size: bytes.length };
  }
  async head(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { key, size: bytes.length } : null;
  }
  async get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const range = options?.range;
    const result = range
      ? bytes.slice(range.offset, range.offset + range.length)
      : bytes;
    return {
      key,
      size: bytes.length,
      body: new Response(result.slice().buffer as ArrayBuffer).body,
    };
  }
  async delete(key: string) {
    if (this.failDelete.has(key))
      throw new Error("Simulated R2 delete failure");
    this.objects.delete(key);
    this.deleted.push(key);
  }
}

export function fixture() {
  const db = new TestDatabase();
  const media = new TestMedia();
  const env = {
    DB: db,
    MEDIA: media,
    GENERATION: { create: async () => ({ id: "fixture-workflow" }) },
    APP_URL: "https://ahab.example",
    AHAB_JWT_SECRET: "test-fixture-signing-value-with-no-production-use",
  } as unknown as AhabEnv;
  return { db, media, env, close: () => db.close() };
}

export async function seedUser(
  db: TestDatabase,
  id = "user-a",
  username = "CreatorA",
  passwordHash = "fixture-unused-password-hash",
  recoveryHash: string | null = null,
) {
  await db
    .prepare(
      "INSERT INTO users(id,username,password_hash,recovery_hash,created_at) VALUES(?,?,?,?,?)",
    )
    .bind(id, username, passwordHash, recoveryHash, Date.now())
    .run();
  return id;
}

export async function seedPurchase(
  db: TestDatabase,
  userId = "user-a",
  packageId = "starter",
  purchaseId = "purchase-a",
) {
  const amount =
    packageId === "starter" ? 1100 : packageId === "studio" ? 2200 : 4700;
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,package_id,amount_cents,created_at) VALUES(?,?,?,?,?)",
    )
    .bind(purchaseId, userId, packageId, amount, Date.now())
    .run();
  return purchaseId;
}

export async function seedAllowance(
  db: TestDatabase,
  userId = "user-a",
  packageId = "starter",
  purchaseId = "purchase-a",
) {
  await seedPurchase(db, userId, packageId, purchaseId);
  await db
    .prepare("UPDATE purchases SET status='paid',paid_at=? WHERE id=?")
    .bind(Date.now(), purchaseId)
    .run();
  return purchaseId;
}
