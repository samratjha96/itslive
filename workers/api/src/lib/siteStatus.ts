// Each exported function represents one named status transition. The SQL UPDATE
// and KV cache invalidation are bundled so they never get out of sync.
//
// KV failures are logged but not re-thrown: D1 is the source of truth, and a
// stale KV entry is recoverable (next serve request falls through to D1 and
// re-populates the cache). Re-throwing after a committed DB mutation is worse
// — it returns a 500 with D1 already changed.

type StatusEnv = { DB: D1Database; KV: KVNamespace };

async function invalidateKv(kv: KVNamespace, siteName: string): Promise<void> {
  try {
    await kv.delete(`site:${siteName}`);
  } catch (err) {
    console.warn(`siteStatus: KV invalidation failed for site:${siteName}:`, err);
  }
}

export async function deactivateSite(env: StatusEnv, siteId: string, siteName: string, reapAt: number): Promise<void> {
  await env.DB
    .prepare("UPDATE sites SET status = 'deactivated', cooling_until = ? WHERE id = ?")
    .bind(reapAt, siteId)
    .run();
  await invalidateKv(env.KV, siteName);
}

export async function restoreSite(env: StatusEnv, siteId: string, siteName: string): Promise<void> {
  await env.DB
    .prepare("UPDATE sites SET status = 'active', cooling_until = NULL WHERE id = ?")
    .bind(siteId)
    .run();
  await invalidateKv(env.KV, siteName);
}

export async function suspendSites(env: StatusEnv, sites: { id: string; name: string }[]): Promise<void> {
  if (sites.length === 0) return;
  await env.DB.batch(
    sites.map(s => env.DB.prepare("UPDATE sites SET status = 'suspended' WHERE id = ?").bind(s.id))
  );
  await Promise.all(sites.map(s => invalidateKv(env.KV, s.name)));
}

export async function unsuspendSites(env: StatusEnv, sites: { id: string; name: string }[]): Promise<void> {
  if (sites.length === 0) return;
  await env.DB.batch(
    sites.map(s => env.DB.prepare("UPDATE sites SET status = 'active' WHERE id = ?").bind(s.id))
  );
  await Promise.all(sites.map(s => invalidateKv(env.KV, s.name)));
}
