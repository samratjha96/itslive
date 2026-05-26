// Cloudflare Queue message contract shared between api and queue workers.
// Both workers must agree on this union — change here, change nowhere else.
export type QueueMessage =
  | { type: 'otp_email'; email: string; code: string }
  | { type: 'welcome_email'; email: string }
  | { type: 'existing_account_notice'; email: string }
  | { type: 'post_deploy_cache_purge'; site_name: string }
  | { type: 'site_delete_cleanup'; site_id: string; user_id: string; site_name: string }
  | { type: 'deploy_cleanup'; site_id: string; deploy_id: string };
