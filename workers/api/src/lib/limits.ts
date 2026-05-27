export const PLAN_LIMITS = {
  free:    { sites: 3,   size_bytes: 5   * 1024 * 1024, deploys_per_month: 50,   api_calls_per_hour: 100,   session_ttl_hrs: 24  },
  builder: { sites: 25,  size_bytes: 25  * 1024 * 1024, deploys_per_month: 500,  api_calls_per_hour: 1000,  session_ttl_hrs: 168 },
  studio:  { sites: 200, size_bytes: 100 * 1024 * 1024, deploys_per_month: null, api_calls_per_hour: 10000, session_ttl_hrs: 720 },
} as const;

export type Plan = keyof typeof PLAN_LIMITS;
