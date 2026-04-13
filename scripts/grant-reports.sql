-- Grant INSERT/SELECT/UPDATE on the player-report table to the app user.
-- The `reports` table was created with postgres-only privileges, so every
-- INSERT from the app failed with `permission denied for table reports`
-- and no report was ever saved. Idempotent — safe to re-run.

GRANT SELECT, INSERT, UPDATE ON public.reports TO overthrow;
