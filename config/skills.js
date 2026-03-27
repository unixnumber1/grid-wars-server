// ── Skill Tree Configuration ── Block-based branching trees

export const SKILL_RESET_COST_PER_POINT = 10; // diamonds per invested point

export const SHADOW_DURATION_MS = 30 * 60 * 1000;  // 30 minutes
export const SHADOW_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── RAIDER TREE ──
export const RAIDER_TREE = [
  // СТВОЛ
  {
    id: 'damage_1', name: 'Урон I', emoji: '⚔️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { weapon_damage_bonus: 0.008 },
    requires: null, unlocks: ['damage_2'],
    position: { col: 4, row: 0 }
  },
  {
    id: 'damage_2', name: 'Урон II', emoji: '⚔️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { weapon_damage_bonus: 0.008 },
    requires: 'damage_1', unlocks: ['damage_3', 'crit_1'],
    position: { col: 4, row: 1 }
  },

  // ЛЕВАЯ ВЕТКА — Урон (тупик)
  {
    id: 'damage_3', name: 'Урон III', emoji: '⚔️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { weapon_damage_bonus: 0.008 },
    requires: 'damage_2', unlocks: ['damage_4'],
    position: { col: 2, row: 2 }
  },
  {
    id: 'damage_4', name: 'Урон IV', emoji: '⚔️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { weapon_damage_bonus: 0.008 },
    requires: 'damage_3', unlocks: ['damage_5'],
    position: { col: 2, row: 3 }
  },
  {
    id: 'damage_5', name: 'Урон V', emoji: '⚔️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { weapon_damage_bonus: 0.008 },
    requires: 'damage_4', unlocks: [],
    position: { col: 2, row: 4 }, dead_end: true
  },

  // ПРАВАЯ ВЕТКА — Крит
  {
    id: 'crit_1', name: 'Крит I', emoji: '🎯', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { crit_chance_bonus: 0.004 },
    requires: 'damage_2', unlocks: ['crit_2'],
    position: { col: 6, row: 2 }
  },
  {
    id: 'crit_2', name: 'Крит II', emoji: '🎯', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { crit_chance_bonus: 0.004 },
    requires: 'crit_1', unlocks: ['crit_3'],
    position: { col: 6, row: 3 }
  },
  {
    id: 'crit_3', name: 'Крит III', emoji: '🎯', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { crit_chance_bonus: 0.004 },
    requires: 'crit_2', unlocks: ['crit_4'],
    position: { col: 6, row: 4 }
  },
  {
    id: 'crit_4', name: 'Крит IV', emoji: '🎯', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { crit_chance_bonus: 0.004 },
    requires: 'crit_3', unlocks: ['speed_1', 'crit_5'],
    position: { col: 6, row: 5 }
  },
  {
    id: 'crit_5', name: 'Крит V', emoji: '🎯', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { crit_chance_bonus: 0.004 },
    requires: 'crit_4', unlocks: ['sniper'],
    position: { col: 8, row: 6 }
  },
  {
    id: 'sniper', name: 'Снайпер', emoji: '🎯', maxLevel: 5, cost: 1,
    type: 'ability', tree: 'raider',
    effect: { sniper_ability: true },
    description: 'Первый удар по новой цели — всегда крит',
    requires: 'crit_5', unlocks: [],
    position: { col: 8, row: 7 }, dead_end: true
  },

  // СКОРОСТЬ
  {
    id: 'speed_1', name: 'Скорость I', emoji: '💨', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { attack_speed_bonus: 0.01 },
    requires: 'crit_4', unlocks: ['speed_2'],
    position: { col: 6, row: 6 }
  },
  {
    id: 'speed_2', name: 'Скорость II', emoji: '💨', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { attack_speed_bonus: 0.01 },
    requires: 'speed_1', unlocks: ['speed_3'],
    position: { col: 6, row: 7 }
  },
  {
    id: 'speed_3', name: 'Скорость III', emoji: '💨', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { attack_speed_bonus: 0.01 },
    requires: 'speed_2', unlocks: ['speed_4', 'vitality_1'],
    position: { col: 6, row: 8 }
  },
  {
    id: 'speed_4', name: 'Скорость IV', emoji: '💨', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { attack_speed_bonus: 0.01 },
    requires: 'speed_3', unlocks: ['speed_5'],
    position: { col: 4, row: 9 }
  },
  {
    id: 'speed_5', name: 'Скорость V', emoji: '💨', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { attack_speed_bonus: 0.01 },
    requires: 'speed_4', unlocks: [],
    position: { col: 4, row: 10 }, dead_end: true
  },

  // ЖИВУЧЕСТЬ
  {
    id: 'vitality_1', name: 'Живучесть I', emoji: '❤️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { player_hp_bonus: 0.008 },
    requires: 'speed_3', unlocks: ['vitality_2'],
    position: { col: 8, row: 9 }
  },
  {
    id: 'vitality_2', name: 'Живучесть II', emoji: '❤️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { player_hp_bonus: 0.008 },
    requires: 'vitality_1', unlocks: ['vitality_3'],
    position: { col: 8, row: 10 }
  },
  {
    id: 'vitality_3', name: 'Живучесть III', emoji: '❤️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { player_hp_bonus: 0.008 },
    requires: 'vitality_2', unlocks: ['vampire_1', 'destroyer_1'],
    position: { col: 8, row: 11 }
  },
  {
    id: 'vitality_4', name: 'Живучесть IV', emoji: '❤️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { player_hp_bonus: 0.008 },
    requires: 'vitality_3', unlocks: ['vitality_5'],
    position: { col: 12, row: 12 }
  },
  {
    id: 'vitality_5', name: 'Живучесть V', emoji: '❤️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { player_hp_bonus: 0.008 },
    requires: 'vitality_4', unlocks: [],
    position: { col: 12, row: 13 }, dead_end: true
  },

  // ВАМПИР
  {
    id: 'vampire_1', name: 'Вампир I', emoji: '🩸', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { lifesteal: 0.003 },
    requires: 'vitality_3', unlocks: ['vampire_2'],
    position: { col: 6, row: 12 }
  },
  {
    id: 'vampire_2', name: 'Вампир II', emoji: '🩸', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { lifesteal: 0.003 },
    requires: 'vampire_1', unlocks: ['vampire_3'],
    position: { col: 6, row: 13 }
  },
  {
    id: 'vampire_3', name: 'Вампир III', emoji: '🩸', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { lifesteal: 0.003 },
    requires: 'vampire_2', unlocks: ['vampire_4'],
    position: { col: 6, row: 14 }
  },
  {
    id: 'vampire_4', name: 'Вампир IV', emoji: '🩸', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { lifesteal: 0.003 },
    requires: 'vampire_3', unlocks: ['vampire_5'],
    position: { col: 6, row: 15 }
  },
  {
    id: 'vampire_5', name: 'Вампир V', emoji: '🩸', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { lifesteal: 0.003 },
    requires: 'vampire_4', unlocks: ['shadow'],
    position: { col: 6, row: 16 }
  },
  {
    id: 'shadow', name: 'Тень', emoji: '🎭', maxLevel: 5, cost: 1,
    type: 'ability', tree: 'raider',
    effect: { shadow_ability: true },
    description: 'Невидим на карте 30 мин, перезарядка 24ч',
    requires: 'vampire_5', unlocks: [],
    position: { col: 6, row: 17 }, dead_end: true
  },

  // РАЗРУШИТЕЛЬ
  {
    id: 'destroyer_1', name: 'Разрушитель I', emoji: '🏛️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { pve_damage_bonus: 0.008 },
    requires: 'vitality_3', unlocks: ['destroyer_2'],
    position: { col: 10, row: 12 }
  },
  {
    id: 'destroyer_2', name: 'Разрушитель II', emoji: '🏛️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { pve_damage_bonus: 0.008 },
    requires: 'destroyer_1', unlocks: ['destroyer_3'],
    position: { col: 10, row: 13 }
  },
  {
    id: 'destroyer_3', name: 'Разрушитель III', emoji: '🏛️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { pve_damage_bonus: 0.008 },
    requires: 'destroyer_2', unlocks: ['destroyer_4'],
    position: { col: 10, row: 14 }
  },
  {
    id: 'destroyer_4', name: 'Разрушитель IV', emoji: '🏛️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { pve_damage_bonus: 0.008 },
    requires: 'destroyer_3', unlocks: ['destroyer_5'],
    position: { col: 10, row: 15 }
  },
  {
    id: 'destroyer_5', name: 'Разрушитель V', emoji: '🏛️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { pve_damage_bonus: 0.008 },
    requires: 'destroyer_4', unlocks: ['marauder_1'],
    position: { col: 10, row: 16 }
  },

  // МАРОДЁР
  {
    id: 'marauder_1', name: 'Мародёр I', emoji: '💀', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { pvp_loot_bonus: 0.01, attack_radius_bonus: 1 },
    requires: 'destroyer_5', unlocks: ['marauder_2'],
    position: { col: 10, row: 17 }
  },
  {
    id: 'marauder_2', name: 'Мародёр II', emoji: '💀', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { pvp_loot_bonus: 0.01, attack_radius_bonus: 1 },
    requires: 'marauder_1', unlocks: ['marauder_3'],
    position: { col: 10, row: 18 }
  },
  {
    id: 'marauder_3', name: 'Мародёр III', emoji: '💀', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { pvp_loot_bonus: 0.01, attack_radius_bonus: 1 },
    requires: 'marauder_2', unlocks: ['marauder_4'],
    position: { col: 10, row: 19 }
  },
  {
    id: 'marauder_4', name: 'Мародёр IV', emoji: '💀', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { pvp_loot_bonus: 0.01, attack_radius_bonus: 1 },
    requires: 'marauder_3', unlocks: ['marauder_5'],
    position: { col: 10, row: 20 }
  },
  {
    id: 'marauder_5', name: 'Мародёр V', emoji: '💀', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'raider',
    effect: { pvp_loot_bonus: 0.01, attack_radius_bonus: 1 },
    requires: 'marauder_4', unlocks: [],
    position: { col: 10, row: 21 }, dead_end: true
  },
];

// ── FARMER TREE ──
export const FARMER_TREE = [
  // СТВОЛ
  {
    id: 'income_1', name: 'Доход I', emoji: '💰', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_income_bonus: 0.01 },
    requires: null, unlocks: ['income_2'],
    position: { col: 4, row: 0 }
  },
  {
    id: 'income_2', name: 'Доход II', emoji: '💰', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_income_bonus: 0.01 },
    requires: 'income_1', unlocks: ['income_3', 'capacity_1'],
    position: { col: 4, row: 1 }
  },

  // ЛЕВАЯ — Доход тупик
  {
    id: 'income_3', name: 'Доход III', emoji: '💰', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_income_bonus: 0.01 },
    requires: 'income_2', unlocks: ['income_4'],
    position: { col: 2, row: 2 }
  },
  {
    id: 'income_4', name: 'Доход IV', emoji: '💰', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_income_bonus: 0.01 },
    requires: 'income_3', unlocks: ['income_5'],
    position: { col: 2, row: 3 }
  },
  {
    id: 'income_5', name: 'Доход V', emoji: '💰', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_income_bonus: 0.01 },
    requires: 'income_4', unlocks: [],
    position: { col: 2, row: 4 }, dead_end: true
  },

  // ПРАВАЯ — Вместимость
  {
    id: 'capacity_1', name: 'Вместимость I', emoji: '📦', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_capacity_bonus: 0.01 },
    requires: 'income_2', unlocks: ['capacity_2'],
    position: { col: 6, row: 2 }
  },
  {
    id: 'capacity_2', name: 'Вместимость II', emoji: '📦', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_capacity_bonus: 0.01 },
    requires: 'capacity_1', unlocks: ['capacity_3'],
    position: { col: 6, row: 3 }
  },
  {
    id: 'capacity_3', name: 'Вместимость III', emoji: '📦', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_capacity_bonus: 0.01 },
    requires: 'capacity_2', unlocks: ['capacity_4'],
    position: { col: 6, row: 4 }
  },
  {
    id: 'capacity_4', name: 'Вместимость IV', emoji: '📦', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_capacity_bonus: 0.01 },
    requires: 'capacity_3', unlocks: ['durability_1', 'capacity_5'],
    position: { col: 6, row: 5 }
  },
  {
    id: 'capacity_5', name: 'Вместимость V', emoji: '📦', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_capacity_bonus: 0.01 },
    requires: 'capacity_4', unlocks: [],
    position: { col: 8, row: 6 }, dead_end: true
  },

  // ПРОЧНОСТЬ
  {
    id: 'durability_1', name: 'Прочность I', emoji: '❤️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_hp_bonus: 0.01 },
    requires: 'capacity_4', unlocks: ['durability_2'],
    position: { col: 6, row: 6 }
  },
  {
    id: 'durability_2', name: 'Прочность II', emoji: '❤️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_hp_bonus: 0.01 },
    requires: 'durability_1', unlocks: ['durability_3'],
    position: { col: 6, row: 7 }
  },
  {
    id: 'durability_3', name: 'Прочность III', emoji: '❤️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_hp_bonus: 0.01 },
    requires: 'durability_2', unlocks: ['durability_4', 'regen_1'],
    position: { col: 6, row: 8 }
  },
  {
    id: 'durability_4', name: 'Прочность IV', emoji: '❤️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_hp_bonus: 0.01 },
    requires: 'durability_3', unlocks: ['durability_5'],
    position: { col: 4, row: 9 }
  },
  {
    id: 'durability_5', name: 'Прочность V', emoji: '❤️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_hp_bonus: 0.01 },
    requires: 'durability_4', unlocks: [],
    position: { col: 4, row: 10 }, dead_end: true
  },

  // РЕГЕН
  {
    id: 'regen_1', name: 'Реген I', emoji: '♻️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_regen_bonus: 0.01 },
    requires: 'durability_3', unlocks: ['regen_2'],
    position: { col: 8, row: 9 }
  },
  {
    id: 'regen_2', name: 'Реген II', emoji: '♻️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_regen_bonus: 0.01 },
    requires: 'regen_1', unlocks: ['regen_3'],
    position: { col: 8, row: 10 }
  },
  {
    id: 'regen_3', name: 'Реген III', emoji: '♻️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_regen_bonus: 0.01 },
    requires: 'regen_2', unlocks: ['gatherer_1', 'teleport_1'],
    position: { col: 8, row: 11 }
  },

  // ДОБЫТЧИК
  {
    id: 'gatherer_1', name: 'Добытчик I', emoji: '✨', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { ore_bonus: 0.01 },
    requires: 'regen_3', unlocks: ['gatherer_2'],
    position: { col: 6, row: 12 }
  },
  {
    id: 'gatherer_2', name: 'Добытчик II', emoji: '✨', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { ore_bonus: 0.01 },
    requires: 'gatherer_1', unlocks: ['gatherer_3'],
    position: { col: 6, row: 13 }
  },
  {
    id: 'gatherer_3', name: 'Добытчик III', emoji: '✨', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { ore_bonus: 0.01 },
    requires: 'gatherer_2', unlocks: ['gatherer_4'],
    position: { col: 6, row: 14 }
  },
  {
    id: 'gatherer_4', name: 'Добытчик IV', emoji: '✨', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { ore_bonus: 0.01 },
    requires: 'gatherer_3', unlocks: ['gatherer_5'],
    position: { col: 6, row: 15 }
  },
  {
    id: 'gatherer_5', name: 'Добытчик V', emoji: '✨', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { ore_bonus: 0.01 },
    requires: 'gatherer_4', unlocks: ['safe'],
    position: { col: 6, row: 16 }
  },
  {
    id: 'safe', name: 'Сейф', emoji: '🔐', maxLevel: 5, cost: 1,
    type: 'ability', tree: 'farmer',
    effect: { safe_pvp_loss: true },
    description: 'При смерти в PvP теряешь 5% монет вместо 10%',
    requires: 'gatherer_5', unlocks: ['defender_1'],
    position: { col: 6, row: 17 }
  },

  // ТЕЛЕПОРТАЦИЯ
  {
    id: 'teleport_1', name: 'Телепорт I', emoji: '⚙️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { collector_speed_bonus: 0.01 },
    requires: 'regen_3', unlocks: ['teleport_2'],
    position: { col: 10, row: 12 }
  },
  {
    id: 'teleport_2', name: 'Телепорт II', emoji: '⚙️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { collector_speed_bonus: 0.01 },
    requires: 'teleport_1', unlocks: ['teleport_3'],
    position: { col: 10, row: 13 }
  },
  {
    id: 'teleport_3', name: 'Телепорт III', emoji: '⚙️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { collector_speed_bonus: 0.01 },
    requires: 'teleport_2', unlocks: ['teleport_4'],
    position: { col: 10, row: 14 }
  },
  {
    id: 'teleport_4', name: 'Телепорт IV', emoji: '⚙️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { collector_speed_bonus: 0.01 },
    requires: 'teleport_3', unlocks: ['teleport_5'],
    position: { col: 10, row: 15 }
  },
  {
    id: 'teleport_5', name: 'Телепорт V', emoji: '⚙️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { instant_collector: true },
    requires: 'teleport_4', unlocks: ['teleport_ability'],
    position: { col: 10, row: 16 }
  },
  {
    id: 'teleport_ability', name: 'Телепортация', emoji: '⚙️', maxLevel: 5, cost: 1,
    type: 'ability', tree: 'farmer',
    effect: { instant_collector: true },
    description: 'Монеты со сборщика зачисляются мгновенно без курьера',
    requires: 'teleport_5', unlocks: [],
    position: { col: 10, row: 17 }, dead_end: true
  },

  // ЗАЩИТНИК
  {
    id: 'defender_1', name: 'Защитник I', emoji: '🛡️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_damage_reduction: 0.0067 },
    requires: 'safe', unlocks: ['defender_2'],
    position: { col: 6, row: 18 }
  },
  {
    id: 'defender_2', name: 'Защитник II', emoji: '🛡️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_damage_reduction: 0.0067 },
    requires: 'defender_1', unlocks: ['defender_3', 'territory_1'],
    position: { col: 6, row: 19 }
  },
  {
    id: 'defender_3', name: 'Защитник III', emoji: '🛡️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_damage_reduction: 0.0067 },
    requires: 'defender_2', unlocks: ['defender_4'],
    position: { col: 4, row: 20 }
  },
  {
    id: 'defender_4', name: 'Защитник IV', emoji: '🛡️', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { mine_damage_reduction: 0.0067 },
    requires: 'defender_3', unlocks: [],
    position: { col: 4, row: 21 }, dead_end: true
  },

  // ТЕРРИТОРИЯ
  {
    id: 'territory_1', name: 'Территория I', emoji: '🌍', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { radius_bonus: 1 },
    requires: 'defender_2', unlocks: ['territory_2'],
    position: { col: 8, row: 20 }
  },
  {
    id: 'territory_2', name: 'Территория II', emoji: '🌍', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { radius_bonus: 1 },
    requires: 'territory_1', unlocks: ['territory_3'],
    position: { col: 8, row: 21 }
  },
  {
    id: 'territory_3', name: 'Территория III', emoji: '🌍', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { radius_bonus: 1 },
    requires: 'territory_2', unlocks: ['territory_4'],
    position: { col: 8, row: 22 }
  },
  {
    id: 'territory_4', name: 'Территория IV', emoji: '🌍', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { radius_bonus: 1 },
    requires: 'territory_3', unlocks: ['territory_5'],
    position: { col: 8, row: 23 }
  },
  {
    id: 'territory_5', name: 'Территория V', emoji: '🌍', maxLevel: 5, cost: 1,
    type: 'stat', tree: 'farmer',
    effect: { radius_bonus: 1 },
    requires: 'territory_4', unlocks: ['landlord'],
    position: { col: 8, row: 24 }
  },
  {
    id: 'landlord', name: 'Землевладелец', emoji: '👑', maxLevel: 5, cost: 1,
    type: 'ability', tree: 'farmer',
    effect: { landlord_bonus: true },
    description: 'Шахты в 200м от тебя дают +15% дохода пока онлайн',
    requires: 'territory_5', unlocks: [],
    position: { col: 8, row: 25 }, dead_end: true
  },
];

// ── Helper functions ──

export function isBlockUnlocked(blockId, playerSkills, tree) {
  const blocks = tree === 'raider' ? RAIDER_TREE : FARMER_TREE;
  const block = blocks.find(b => b.id === blockId);
  if (!block) return false;
  if (!block.requires) return true;

  const reqBlock = blocks.find(b => b.id === block.requires);
  if (!reqBlock) return false;

  const currentLevel = playerSkills[block.requires] || 0;
  return currentLevel >= (reqBlock.maxLevel || 5);
}

export function getSkillEffects(playerSkills, tree) {
  const blocks = tree === 'raider' ? RAIDER_TREE : FARMER_TREE;
  const effects = {};

  for (const block of blocks) {
    const level = playerSkills[block.id] || 0;
    if (level === 0) continue;

    for (const [key, valuePerLevel] of Object.entries(block.effect)) {
      if (typeof valuePerLevel === 'boolean') {
        effects[key] = level >= (block.maxLevel || 5);
      } else {
        effects[key] = (effects[key] || 0) + valuePerLevel * level;
      }
    }
  }

  return effects;
}

export function getAllSkillEffects(playerSkills) {
  const raiderEffects = getSkillEffects(playerSkills?.raider || {}, 'raider');
  const farmerEffects = getSkillEffects(playerSkills?.farmer || {}, 'farmer');
  return { ...farmerEffects, ...raiderEffects };
}

// Backward-compatible wrapper (same signature as old getPlayerSkillEffects)
export function getPlayerSkillEffects(playerSkillsRow) {
  const defaults = {
    mine_income_bonus: 0,
    mine_capacity_bonus: 0,
    mine_hp_bonus: 0,
    mine_regen_bonus: 0,
    ore_bonus: 0,
    instant_collector: false,
    mine_damage_reduction: 0,
    radius_bonus: 0,
    safe_pvp_loss: false,
    landlord_bonus: false,
    weapon_damage_bonus: 0,
    crit_chance_bonus: 0,
    player_hp_bonus: 0,
    attack_speed_bonus: 0,
    pve_damage_bonus: 0,
    pvp_loot_bonus: 0,
    lifesteal: 0,
    attack_radius_bonus: 0,
    sniper_ability: false,
    shadow_ability: false,
    collector_speed_bonus: 0,
  };

  const computed = getAllSkillEffects(playerSkillsRow);
  return { ...defaults, ...computed };
}
