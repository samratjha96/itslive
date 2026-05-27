export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  SITES: R2Bucket;
  QUEUE: Queue;
  RESEND_API_KEY: string;
  SERVE_DOMAIN: string;
  ENVIRONMENT: string;
  ALLOW_DEV_CODES?: string;
}

export interface User {
  id: string;
  email: string;
  plan: Plan;
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
  status: 'active' | 'suspended' | 'deleted' | 'deleted_cooling' | 'deactivated';
  cooling_until: number | null;
  created_at: number;
  deployed_at: number | null;
  active_deploy_id: string | null;
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
  status: 'uploading' | 'active' | 'superseded' | 'failed';
  object_prefix: string | null;
  manifest_json: string | null;
  agent_ua: string | null;
}

export interface AuthContext {
  userId: string;
  plan: Plan;
  keyId: string;
}

export type { QueueMessage } from 'itslive-shared';
import type { Plan } from './lib/limits';
export type { Plan };
