-- Performance indexes for Grid Wars
-- Run on VPS: psql -U overthrow -d overthrow_db -f scripts/add-indexes.sql

CREATE INDEX IF NOT EXISTS idx_items_owner_equipped ON items(owner_id) WHERE equipped = true;
CREATE INDEX IF NOT EXISTS idx_notifications_player_unread ON notifications(player_id) WHERE read = false;
CREATE INDEX IF NOT EXISTS idx_cores_mine_cell_id ON cores(mine_cell_id) WHERE mine_cell_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mines_owner_id ON mines(owner_id);
CREATE INDEX IF NOT EXISTS idx_mines_status ON mines(status) WHERE status != 'destroyed';
