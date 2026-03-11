-- Items system: equippable loot from vases

-- Items table (must be created before player FK references)
CREATE TABLE IF NOT EXISTS items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('sword', 'shield')),
  rarity      text NOT NULL CHECK (rarity IN ('common', 'rare', 'uncommon', 'epic', 'mythic', 'legendary')),
  name        text NOT NULL,
  emoji       text NOT NULL,
  stat_value  integer NOT NULL DEFAULT 0,
  equipped    boolean NOT NULL DEFAULT false,
  obtained_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS items_owner_idx ON items(owner_id);

-- New columns on players
ALTER TABLE players ADD COLUMN IF NOT EXISTS bonus_attack    integer NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS bonus_hp        integer NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS equipped_sword  uuid REFERENCES items(id);
ALTER TABLE players ADD COLUMN IF NOT EXISTS equipped_shield uuid REFERENCES items(id);
