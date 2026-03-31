// Weekly login streak reward pools (4 rotating weeks)
// Format mirrors levelRewards: { diamonds, shards, ether, boxes, coreChance }

export const STREAK_POOLS = [
  // ── Week 0: Diamond focus ──
  [
    { diamonds: 3 },
    { shards: 75 },
    { diamonds: 3 },
    { ether: 75 },
    { diamonds: 5 },
    { shards: 150 },
    { boxes: ['common'], },
  ],
  // ── Week 1: Crystal focus ──
  [
    { shards: 150 },
    { diamonds: 3 },
    { shards: 225 },
    { diamonds: 3 },
    { shards: 300 },
    { ether: 150 },
    { boxes: ['common'], },
  ],
  // ── Week 2: Ether focus ──
  [
    { ether: 150 },
    { shards: 75 },
    { diamonds: 3 },
    { ether: 225 },
    { ether: 150 },
    { diamonds: 5 },
    { boxes: ['common'], },
  ],
  // ── Week 3: Mixed + rare box on day 7 ──
  [
    { diamonds: 3 },
    { ether: 150 },
    { shards: 225 },
    { diamonds: 3 },
    { ether: 150 },
    { diamonds: 5 },
    { boxes: ['rare'], },
  ],
];

export const STREAK_POOL_COUNT = STREAK_POOLS.length;
