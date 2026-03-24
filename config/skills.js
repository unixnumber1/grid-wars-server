// ── Skill Tree Configuration ──

export const SKILL_RESET_COST_PER_POINT = 10; // diamonds per invested point

export const SHADOW_DURATION_MS = 30 * 60 * 1000;  // 30 minutes
export const SHADOW_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

export const FARMER_SKILLS = [
  {
    id: 'income',
    name: 'Доход',
    emoji: '💰',
    maxPoints: 20,
    color: '#FFD700',
    description: '+1% к доходу всех шахт за каждое очко',
    getEffect: (points) => ({ mine_income_bonus: points * 0.01 }),
    ability: null
  },
  {
    id: 'capacity',
    name: 'Вместимость',
    emoji: '📦',
    maxPoints: 20,
    color: '#FF9800',
    description: '+1% к вместимости шахт за очко',
    getEffect: (points) => ({ mine_capacity_bonus: points * 0.01 }),
    ability: null
  },
  {
    id: 'durability',
    name: 'Прочность',
    emoji: '❤️',
    maxPoints: 25,
    color: '#f44336',
    description: '+1% к HP шахт за очко',
    getEffect: (points) => ({ mine_hp_bonus: points * 0.01 }),
    ability: null
  },
  {
    id: 'regen',
    name: 'Реген',
    emoji: '♻️',
    maxPoints: 20,
    color: '#4caf50',
    description: '+1% к скорости регена HP шахт за очко',
    getEffect: (points) => ({ mine_regen_bonus: points * 0.01 }),
    ability: null
  },
  {
    id: 'gatherer',
    name: 'Добытчик',
    emoji: '✨',
    maxPoints: 25,
    color: '#9c27b0',
    description: '+1% осколков и эфира с рудников за очко',
    getEffect: (points) => ({ ore_bonus: points * 0.01 }),
    ability: {
      id: 'safe',
      name: 'Сейф',
      emoji: '🔐',
      description: 'При смерти в PvP теряешь 5% монет вместо 10%',
      unlocksAt: 25
    }
  },
  {
    id: 'teleport',
    name: 'Телепортация',
    emoji: '⚙️',
    maxPoints: 25,
    color: '#00bcd4',
    description: 'Монеты со сборщика зачисляются мгновенно без курьера при полной прокачке',
    getEffect: (points) => ({ instant_collector: points >= 25 }),
    ability: null
  },
  {
    id: 'defender',
    name: 'Защитник',
    emoji: '🛡️',
    maxPoints: 30,
    color: '#607d8b',
    description: '-0.67% к урону по твоим шахтам за очко (макс -20%)',
    getEffect: (points) => ({ mine_damage_reduction: points * 0.0067 }),
    ability: null
  },
  {
    id: 'territory',
    name: 'Территория',
    emoji: '🌍',
    maxPoints: 35,
    color: '#2196f3',
    description: '+0.57м к радиусу взаимодействия за очко (макс +20м)',
    getEffect: (points) => ({ radius_bonus: Math.floor(points * 0.57) }),
    ability: {
      id: 'landlord',
      name: 'Землевладелец',
      emoji: '👑',
      description: 'Твои шахты в 200м дают +15% дохода пока ты онлайн',
      unlocksAt: 35
    }
  }
];

export const RAIDER_SKILLS = [
  {
    id: 'damage',
    name: 'Урон',
    emoji: '⚔️',
    maxPoints: 25,
    color: '#f44336',
    description: '+0.8% к урону оружия за очко (макс +20%)',
    getEffect: (points) => ({ weapon_damage_bonus: points * 0.008 }),
    ability: null
  },
  {
    id: 'crit',
    name: 'Крит',
    emoji: '🎯',
    maxPoints: 20,
    color: '#FF9800',
    description: '+0.4% к шансу крита за очко (макс +8%)',
    getEffect: (points) => ({ crit_chance_bonus: points * 0.004 }),
    ability: null
  },
  {
    id: 'vitality',
    name: 'Живучесть',
    emoji: '❤️',
    maxPoints: 25,
    color: '#e91e63',
    description: '+0.8% к HP игрока за очко (макс +20%, 1000→1200)',
    getEffect: (points) => ({ player_hp_bonus: points * 0.008 }),
    ability: null
  },
  {
    id: 'speed',
    name: 'Скорость',
    emoji: '💨',
    maxPoints: 20,
    color: '#00bcd4',
    description: '-0.75% к КД оружия за очко (макс -15%)',
    getEffect: (points) => ({ attack_speed_bonus: points * 0.0075 }),
    ability: null
  },
  {
    id: 'destroyer',
    name: 'Разрушитель',
    emoji: '🏛️',
    maxPoints: 25,
    color: '#FF5722',
    description: '+0.8% к урону по монументам и зомби за очко (макс +20%)',
    getEffect: (points) => ({ pve_damage_bonus: points * 0.008 }),
    ability: {
      id: 'sniper',
      name: 'Снайпер',
      emoji: '🎯',
      description: 'Первый удар по любой новой цели всегда крит. Перезарядка при смене цели.',
      unlocksAt: 25
    }
  },
  {
    id: 'marauder',
    name: 'Мародёр',
    emoji: '💀',
    maxPoints: 25,
    color: '#795548',
    description: '+1% монет с победы в PvP за очко (макс +25%)',
    getEffect: (points) => ({ pvp_loot_bonus: points * 0.01 }),
    ability: null
  },
  {
    id: 'vampire',
    name: 'Вампир',
    emoji: '🩸',
    maxPoints: 30,
    color: '#880E4F',
    description: '0.2% нанесённого урона восстанавливает HP за очко (макс 6%)',
    getEffect: (points) => ({ lifesteal: points * 0.002 }),
    ability: null
  },
  {
    id: 'shadow',
    name: 'Охотник',
    emoji: '🎭',
    maxPoints: 30,
    color: '#424242',
    description: '+1м к радиусу атаки за очко (макс +30м, 500→530м)',
    getEffect: (points) => ({ attack_radius_bonus: points }),
    ability: {
      id: 'invisible',
      name: 'Тень',
      emoji: '🎭',
      description: 'Исчезаешь с карты других игроков на 30 минут. Перезарядка 24ч.',
      unlocksAt: 30
    }
  }
];

export const SKILL_ORDER = {
  farmer: ['income', 'capacity', 'durability', 'regen', 'gatherer', 'teleport', 'defender', 'territory'],
  raider: ['damage', 'crit', 'vitality', 'speed', 'destroyer', 'marauder', 'vampire', 'shadow']
};

export function isSkillUnlocked(skills, tree, skillId) {
  const order = SKILL_ORDER[tree];
  const idx = order.indexOf(skillId);
  if (idx === 0) return true;

  const prevSkillId = order[idx - 1];
  const prevSkill = tree === 'farmer'
    ? FARMER_SKILLS.find(s => s.id === prevSkillId)
    : RAIDER_SKILLS.find(s => s.id === prevSkillId);

  const prevPoints = skills[prevSkillId] || 0;
  const threshold = Math.ceil(prevSkill.maxPoints * 0.5);

  return prevPoints >= threshold;
}

export function getPlayerSkillEffects(playerSkills) {
  const effects = {
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
  };

  const farmer = playerSkills?.farmer || {};
  for (const skill of FARMER_SKILLS) {
    const points = farmer[skill.id] || 0;
    if (points === 0) continue;
    const skillEffects = skill.getEffect(points);
    Object.assign(effects, skillEffects);

    if (skill.ability && points >= skill.ability.unlocksAt) {
      if (skill.ability.id === 'safe') effects.safe_pvp_loss = true;
      if (skill.ability.id === 'landlord') effects.landlord_bonus = true;
    }
  }

  const raider = playerSkills?.raider || {};
  for (const skill of RAIDER_SKILLS) {
    const points = raider[skill.id] || 0;
    if (points === 0) continue;
    const skillEffects = skill.getEffect(points);
    Object.assign(effects, skillEffects);

    if (skill.ability && points >= skill.ability.unlocksAt) {
      if (skill.ability.id === 'sniper') effects.sniper_ability = true;
      if (skill.ability.id === 'invisible') effects.shadow_ability = true;
    }
  }

  return effects;
}
