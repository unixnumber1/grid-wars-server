import { gameState } from '../state/GameState.js';
import { supabase } from '../../lib/supabase.js';
import {
  FARMER_TREE, RAIDER_TREE,
  isBlockUnlocked, getPlayerSkillEffects,
  SKILL_RESET_COST_PER_POINT,
  SHADOW_DURATION_MS, SHADOW_COOLDOWN_MS
} from '../../config/skills.js';

// Track sniper first-hit targets: Map<telegramId, lastTargetId>
const sniperLastTarget = new Map();

export function getSniperFirstHit(attackerTgId, targetId) {
  const last = sniperLastTarget.get(attackerTgId);
  if (last !== targetId) {
    sniperLastTarget.set(attackerTgId, targetId);
    return true; // first hit on new target
  }
  return false;
}

export function resetSniperTarget(attackerTgId) {
  sniperLastTarget.delete(attackerTgId);
}

function getTree(tree) {
  return tree === 'raider' ? RAIDER_TREE : FARMER_TREE;
}

async function persistSkills(playerSkillRow) {
  playerSkillRow.updated_at = new Date().toISOString();
  await supabase.from('player_skills').upsert(playerSkillRow, { onConflict: 'player_id' });
}

export async function handleGet(body, player) {
  const skillRow = gameState.getPlayerSkills(Number(player.telegram_id));
  const level = player.level || 1;
  const totalSpent = skillRow.skill_points_used || 0;
  const available = Math.max(0, level - totalSpent);
  const effects = getPlayerSkillEffects(skillRow);

  return {
    ok: true,
    farmer_tree: FARMER_TREE,
    raider_tree: RAIDER_TREE,
    farmer: skillRow.farmer || {},
    raider: skillRow.raider || {},
    skill_points_used: totalSpent,
    available_points: available,
    reset_cost: totalSpent * SKILL_RESET_COST_PER_POINT,
    effects,
    shadow_active: player._shadow_until ? Date.now() < player._shadow_until : false,
    shadow_until: player._shadow_until || null,
    shadow_cooldown: player._shadow_cooldown || null,
  };
}

export async function handleInvest(body, player) {
  const { tree, block_id, skill_id } = body;
  const blockId = block_id || skill_id;
  if (!tree || !blockId) return { status: 400, error: 'Missing tree or block_id' };
  if (tree !== 'farmer' && tree !== 'raider') return { status: 400, error: 'Invalid tree' };

  const blocks = getTree(tree);
  const block = blocks.find(b => b.id === blockId);
  if (!block) return { status: 400, error: 'Блок не найден' };

  const skillRow = gameState.getPlayerSkills(Number(player.telegram_id));
  const level = player.level || 1;
  const totalSpent = skillRow.skill_points_used || 0;

  if (level <= totalSpent) return { status: 400, error: 'Нет доступных очков' };

  const branchData = skillRow[tree] || {};
  const currentLevel = branchData[blockId] || 0;
  const maxLevel = block.maxLevel || 5;

  if (currentLevel >= maxLevel) return { status: 400, error: 'Блок уже максимального уровня' };

  if (!isBlockUnlocked(blockId, branchData, tree)) return { status: 400, error: 'Сначала прокачай предыдущий блок до максимума' };

  // Apply
  branchData[blockId] = currentLevel + 1;
  skillRow[tree] = branchData;
  skillRow.skill_points_used = totalSpent + 1;

  // Update gameState
  gameState.playerSkills.set(Number(player.telegram_id), skillRow);

  // Persist immediately
  await persistSkills(skillRow);

  const effects = getPlayerSkillEffects(skillRow);
  const available = Math.max(0, level - skillRow.skill_points_used);

  return {
    ok: true,
    block_name: block.name,
    new_level: currentLevel + 1,
    farmer: skillRow.farmer,
    raider: skillRow.raider,
    skill_points_used: skillRow.skill_points_used,
    available_points: available,
    reset_cost: skillRow.skill_points_used * SKILL_RESET_COST_PER_POINT,
    effects,
  };
}

export async function handleReset(body, player) {
  const skillRow = gameState.getPlayerSkills(Number(player.telegram_id));
  const totalSpent = skillRow.skill_points_used || 0;

  if (totalSpent === 0) return { status: 400, error: 'Нечего сбрасывать' };

  const cost = totalSpent * SKILL_RESET_COST_PER_POINT;
  if ((player.diamonds || 0) < cost) return { status: 400, error: `Не хватает алмазов (нужно ${cost}💎)` };

  // Deduct diamonds
  player.diamonds = (player.diamonds || 0) - cost;
  gameState.markDirty('players', player.id);
  await supabase.from('players').update({ diamonds: player.diamonds }).eq('id', player.id);

  // Reset skills
  skillRow.farmer = {};
  skillRow.raider = {};
  skillRow.skill_points_used = 0;

  gameState.playerSkills.set(Number(player.telegram_id), skillRow);
  await persistSkills(skillRow);

  // Reset sniper target tracking
  resetSniperTarget(Number(player.telegram_id));

  const effects = getPlayerSkillEffects(skillRow);
  const level = player.level || 1;

  return {
    ok: true,
    farmer: {},
    raider: {},
    skill_points_used: 0,
    available_points: level,
    reset_cost: 0,
    effects,
    diamonds_spent: cost,
  };
}

export async function handleActivateShadow(body, player) {
  const skillRow = gameState.getPlayerSkills(Number(player.telegram_id));
  const effects = getPlayerSkillEffects(skillRow);

  if (!effects.shadow_ability) return { status: 400, error: 'Способность не разблокирована' };

  const now = Date.now();

  // Check cooldown
  if (player._shadow_cooldown && now < player._shadow_cooldown) {
    const remaining = player._shadow_cooldown - now;
    return { status: 400, error: 'Перезарядка', cooldown_remaining: remaining };
  }

  // Check if already active
  if (player._shadow_until && now < player._shadow_until) {
    return { status: 400, error: 'Уже активна', shadow_until: player._shadow_until };
  }

  // Activate
  player._shadow_until = now + SHADOW_DURATION_MS;
  player._shadow_cooldown = now + SHADOW_COOLDOWN_MS;

  // Persist to player_skills row so it survives restart
  const skillRow = gameState.getPlayerSkills(Number(player.telegram_id));
  skillRow.shadow_until = player._shadow_until;
  skillRow.shadow_cooldown = player._shadow_cooldown;
  await persistSkills(skillRow);

  return {
    ok: true,
    shadow_active: true,
    shadow_until: player._shadow_until,
    shadow_cooldown: player._shadow_cooldown,
  };
}
