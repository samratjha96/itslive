export const PLAN_LIMITS = {
  free: { sites: 3,   size_bytes: 5  * 1024 * 1024, deploys_per_month: 50,   api_calls_per_hour: 100,  session_ttl_hrs: 24  },
  pro:  { sites: 500, size_bytes: 25 * 1024 * 1024, deploys_per_month: null, api_calls_per_hour: 2000, session_ttl_hrs: 720 },
} as const;

export type Plan = keyof typeof PLAN_LIMITS;
