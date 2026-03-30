-- Migration: add coins column to couriers and courier_drops
-- Run on PostgreSQL before deploying the code changes

ALTER TABLE couriers ADD COLUMN IF NOT EXISTS coins BIGINT DEFAULT 0;
ALTER TABLE courier_drops ADD COLUMN IF NOT EXISTS coins BIGINT DEFAULT 0;

-- Fix core_id type mismatch: was integer, but cores.id is uuid
ALTER TABLE courier_drops ALTER COLUMN core_id TYPE uuid USING core_id::text::uuid;
