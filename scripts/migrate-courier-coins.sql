-- Migration: add coins column to couriers and courier_drops
-- Run on PostgreSQL before deploying the code changes

ALTER TABLE couriers ADD COLUMN IF NOT EXISTS coins BIGINT DEFAULT 0;
ALTER TABLE courier_drops ADD COLUMN IF NOT EXISTS coins BIGINT DEFAULT 0;
