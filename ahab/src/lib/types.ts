export interface AhabEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  MEDIA: R2Bucket;
  GENERATION: Workflow<{ jobId: string }>;
  AHAB_JWT_SECRET: string;
  OPENROUTER_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  APP_URL: string;
  GENERATION_ENABLED?: string;
  CHECKOUT_ENABLED?: string;
  USDC_ENABLED?: string;
  AVATAR_LONG_DURATION_VERIFIED?: string;
  AHAB_AVATAR_VOICES?: string;
  AHAB_AVATAR_MAX_SECONDS_VERIFIED?: string;
}
export interface User {
  id: string;
  username: string;
  recoveryEnabled: boolean;
}
export interface AssetRow {
  id: string;
  user_id: string;
  kind: "image" | "audio" | "video" | "output";
  r2_key: string;
  name: string;
  mime: string;
  bytes: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  created_at: number;
  expires_at: number | null;
}
export interface JobRow {
  id: string;
  user_id: string;
  allowance_id: string;
  kind: "video" | "portrait";
  mode: "presenter" | "video_reference" | "portrait";
  duration: number;
  request_json: string;
  status: string;
  provider_id: string | null;
  asset_id: string | null;
  estimate_cents: number;
  actual_cents: number | null;
  released: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}
