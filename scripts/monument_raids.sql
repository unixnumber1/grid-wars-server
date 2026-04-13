-- Raid history for monuments. One row per defeat event.
-- Killer = player with the most damage in monument_raid_damage for that defeat.
-- monument_level snapshots the level at the moment of defeat (not the current,
-- post-respawn level).
-- Idempotent — safe to re-run; uses IF NOT EXISTS / ON CONFLICT.

CREATE TABLE IF NOT EXISTS public.monument_raids (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monument_id        uuid NOT NULL,
  defeated_at        timestamptz NOT NULL DEFAULT now(),
  killer_id          bigint,
  killer_name        text,
  monument_level     integer,           -- nullable: backfilled rows have no level
  participant_count  integer DEFAULT 0,
  total_damage       bigint DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_monument_raids_monument_defeated_at
  ON public.monument_raids (monument_id, defeated_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.monument_raids TO overthrow;

-- ── Backfill from existing monument_raid_damage groupings ───────────────
-- Each (monument_id, joined_at) group is a single bulk insert from one
-- defeat. Picks the row with the most damage as killer. monument_level
-- stays NULL — only future defeats know their level at insert time.
INSERT INTO public.monument_raids
  (id, monument_id, defeated_at, killer_id, killer_name, monument_level, participant_count, total_damage)
SELECT
  gen_random_uuid(),
  rd.monument_id,
  rd.joined_at AS defeated_at,
  topper.player_id AS killer_id,
  p.game_username AS killer_name,
  NULL::integer AS monument_level,
  rd.participant_count,
  rd.total_damage
FROM (
  SELECT monument_id, joined_at,
         COUNT(*) AS participant_count,
         SUM(damage_dealt)::bigint AS total_damage
  FROM public.monument_raid_damage
  GROUP BY monument_id, joined_at
) rd
LEFT JOIN LATERAL (
  SELECT player_id
  FROM public.monument_raid_damage rd2
  WHERE rd2.monument_id = rd.monument_id
    AND rd2.joined_at   = rd.joined_at
  ORDER BY damage_dealt DESC
  LIMIT 1
) topper ON true
LEFT JOIN public.players p ON p.telegram_id = topper.player_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.monument_raids mr
  WHERE mr.monument_id = rd.monument_id
    AND mr.defeated_at = rd.joined_at
);
