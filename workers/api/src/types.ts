export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  SITES: R2Bucket;
  QUEUE: Queue;
  RESEND_API_KEY: string;
  SERVE_BASE_URL: string;
  ENVIRONMENT: string;
}

export interface User {
  id: string;
  email: string;
  plan: 'free' | 'builder' | 'studio';
  created_at: number;
  verified_at: number | null;
  stripe_id: string | null;
}

export interface ApiKey {
  id: string;
  user_id: string;
  key_hash: string;
  prefix: string;
  created_at: number;
  rotated_at: number | null;
  last_used: number | null;
}

export interface Site {
  id: string;
  user_id: string;
  name: string;
  slug_type: 'auto' | 'custom';
  type: 'static' | 'dynamic';
  status: 'active' | 'deleted' | 'deleted_cooling';
  cooling_until: number | null;
  created_at: number;
  deployed_at: number | null;
  worker_id: string | null;
  db_id: string | null;
  password_hash: string | null;
  session_ttl_hrs: number;
}

export interface Deploy {
  id: string;
  site_id: string;
  deployed_at: number;
  size_bytes: number;
  file_count: number;
  sha256: string;
  agent_ua: string | null;
}

export interface AuthContext {
  userId: string;
  plan: 'free' | 'builder' | 'studio';
  keyId: string;
}

// Cloudflare Queue message types — closed union, no unknown types executed
export type QueueMessage =
  | { type: 'otp_email'; email: string; code: string }
  | { type: 'welcome_email'; email: string }
  | { type: 'existing_account_notice'; email: string }
  | { type: 'post_deploy_cache_purge'; site_name: string }
  | { type: 'site_delete_cleanup'; site_id: string; user_id: string; site_name: string };

export const PLAN_LIMITS = {
  free:    { sites: 3,   size_bytes: 5 * 1024 * 1024,   deploys_per_month: 50,   api_calls_per_hour: 100 },
  builder: { sites: 25,  size_bytes: 25 * 1024 * 1024,  deploys_per_month: 500,  api_calls_per_hour: 1000 },
  studio:  { sites: 200, size_bytes: 100 * 1024 * 1024, deploys_per_month: null, api_calls_per_hour: 10000 },
} as const;

export type Plan = keyof typeof PLAN_LIMITS;
