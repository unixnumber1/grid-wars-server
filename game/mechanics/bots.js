// Currently only goblin is active; other types were removed during simplification
export const BOT_TYPES = {
  goblin: {
    emoji: '\u{1F47A}', category: 'undead',
    hp: 3000, attack: 8, attackChance: 0.3, drain_per_sec: 1000, speed: 'medium',
    reward_min: 0, reward_max: 0, size: 'S', markerSize: 32, spawnWeight: 100,
  },
};

export const SPEED_STEP = { slow: 0.0003, medium: 0.0005, fast: 0.0008 };

export function getRandomBotType() {
  return 'goblin';
}

export function getRandomReward(botCfg) {
  return Math.floor(botCfg.reward_min + Math.random() * (botCfg.reward_max - botCfg.reward_min));
}
