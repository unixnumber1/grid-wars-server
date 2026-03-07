export const BOT_TYPES = {
  // NEUTRAL — fight or lure for coins
  spirit: {
    emoji: '🌫️',
    category: 'neutral',
    hp: 30, attack: 0, attackChance: 0,
    drain_per_sec: 0,
    speed: 'slow',
    reward_min: 8_000, reward_max: 20_000,
    size: 'S', markerSize: 32,
    spawnWeight: 25,
  },
  // UNDEAD — drain mines, fight back
  goblin: {
    emoji: '👺',
    category: 'undead',
    hp: 50, attack: 8, attackChance: 0.3,
    drain_per_sec: 1,
    speed: 'medium',
    reward_min: 0, reward_max: 0,
    size: 'S', markerSize: 32,
    spawnWeight: 25,
  },
  werewolf: {
    emoji: '🐺',
    category: 'undead',
    hp: 120, attack: 20, attackChance: 0.5,
    drain_per_sec: 2,
    speed: 'fast',
    reward_min: 0, reward_max: 0,
    size: 'M', markerSize: 38,
    spawnWeight: 20,
  },
  demon: {
    emoji: '👹',
    category: 'undead',
    hp: 200, attack: 35, attackChance: 0.6,
    drain_per_sec: 4,
    speed: 'fast',
    reward_min: 0, reward_max: 0,
    size: 'L', markerSize: 44,
    spawnWeight: 15,
  },
  // NEUTRAL but fights back
  dragon: {
    emoji: '🐲',
    category: 'neutral',
    hp: 400, attack: 60, attackChance: 0.4,
    drain_per_sec: 0,
    speed: 'medium',
    reward_min: 50_000, reward_max: 200_000,
    size: 'L', markerSize: 50,
    spawnWeight: 10,
  },
  // BOSS — one globally at a time
  boss: {
    emoji: '💀',
    category: 'undead',
    hp: 1000, attack: 100, attackChance: 0.8,
    drain_per_sec: 15,
    speed: 'slow',
    reward_min: 0, reward_max: 0,
    size: 'XL', markerSize: 60,
    spawnWeight: 0, // spawned via special logic, not random
  },
};

export const SPEED_STEP = {
  slow:   0.0003,
  medium: 0.0005,
  fast:   0.0008,
};

export function getRandomBotType() {
  const entries = Object.entries(BOT_TYPES).filter(([, cfg]) => cfg.spawnWeight > 0);
  const total   = entries.reduce((a, [, cfg]) => a + cfg.spawnWeight, 0);
  let rand      = Math.random() * total;
  for (const [type, cfg] of entries) {
    rand -= cfg.spawnWeight;
    if (rand <= 0) return type;
  }
  return 'spirit';
}

export function getRandomReward(botCfg) {
  return Math.floor(botCfg.reward_min + Math.random() * (botCfg.reward_max - botCfg.reward_min));
}
