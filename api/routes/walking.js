import { Router } from 'express';
import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { gameState } from '../../lib/gameState.js';
import { withPlayerLock } from '../../lib/playerLock.js';
import { grantReward } from './rewards.js';
import {
  WALK_DAILY_THRESHOLDS,
  WALK_WEEKLY_THRESHOLDS,
  WALK_DAILY_REWARD_POOLS,
  WALK_WEEKLY_REWARDS,
} from '../../config/constants.js';

export const walkingRouter = Router();

// ── Deterministic daily reward type (seed = date + tgId) ──
function getDailyRewardPool(tgId) {
  const mskNow = new Date(Date.now() + 3 * 3600000);
  const dateStr = mskNow.toISOString().slice(0, 10);
  let hash = 0;
  const seed = dateStr + ':' + tgId;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const idx = ((hash % WALK_DAILY_REWARD_POOLS.length) + WALK_DAILY_REWARD_POOLS.length) % WALK_DAILY_REWARD_POOLS.length;
  return WALK_DAILY_REWARD_POOLS[idx];
}

// ── MSK week reset timer ──
function getWeekResetIn() {
  const mskNow = new Date(Date.now() + 3 * 3600000);
  // Find next Monday 00:00 MSK
  const daysUntilMon = (8 - mskNow.getUTCDay()) % 7 || 7;
  const nextMon = new Date(mskNow);
  nextMon.setUTCDate(nextMon.getUTCDate() + daysUntilMon);
  nextMon.setUTCHours(0, 0, 0, 0);
  return nextMon.getTime() - mskNow.getTime();
}

walkingRouter.post('/', async (req, res) => {
  const { action, telegram_id, tier } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  if (action === 'check') return handleCheck(req, res);
  if (action === 'claim-daily') return handleClaimDaily(req, res);
  if (action === 'claim-weekly') return handleClaimWeekly(req, res);
  return res.status(400).json({ error: 'Unknown action' });
});

async function handleCheck(req, res) {
  const { telegram_id } = req.body;
  const p = gameState.getPlayerByTgId(Number(telegram_id));
  if (!p) return res.status(404).json({ error: 'Player not found' });

  const dailyPool = getDailyRewardPool(telegram_id);

  return res.json({
    daily_m: Math.floor(p.walk_daily_m || 0),
    weekly_m: Math.floor(p.walk_weekly_m || 0),
    daily_claimed: p.walk_daily_claimed || 0,
    weekly_claimed: p.walk_weekly_claimed || 0,
    daily_rewards: dailyPool,
    daily_thresholds: WALK_DAILY_THRESHOLDS,
    weekly_thresholds: WALK_WEEKLY_THRESHOLDS,
    weekly_rewards: WALK_WEEKLY_REWARDS,
    week_reset_in: getWeekResetIn(),
  });
}

async function handleClaimDaily(req, res) {
  const { telegram_id, tier } = req.body;
  if (tier == null || tier < 0 || tier > 2) return res.status(400).json({ error: 'Invalid tier' });

  return withPlayerLock(telegram_id, async () => {
    const p = gameState.getPlayerByTgId(Number(telegram_id));
    if (!p) return res.status(404).json({ error: 'Player not found' });

    const threshold = WALK_DAILY_THRESHOLDS[tier];
    const currentM = p.walk_daily_m || 0;
    if (currentM < threshold) return res.status(400).json({ error: 'Threshold not reached' });

    const claimed = p.walk_daily_claimed || 0;
    if (claimed & (1 << tier)) return res.status(400).json({ error: 'Already claimed' });

    const pool = getDailyRewardPool(telegram_id);
    const rewardDef = {};
    rewardDef[pool.type] = pool.values[tier];

    const granted = await grantReward(p, telegram_id, rewardDef);

    p.walk_daily_claimed = claimed | (1 << tier);
    gameState.markDirty('players', p.id);

    await supabase.from('players').update({
      walk_daily_claimed: p.walk_daily_claimed,
    }).eq('id', p.id);

    return res.json({ success: true, tier, reward: granted });
  });
}

async function handleClaimWeekly(req, res) {
  const { telegram_id, tier } = req.body;
  if (tier == null || tier < 0 || tier > 2) return res.status(400).json({ error: 'Invalid tier' });

  return withPlayerLock(telegram_id, async () => {
    const p = gameState.getPlayerByTgId(Number(telegram_id));
    if (!p) return res.status(404).json({ error: 'Player not found' });

    const threshold = WALK_WEEKLY_THRESHOLDS[tier];
    const currentM = p.walk_weekly_m || 0;
    if (currentM < threshold) return res.status(400).json({ error: 'Threshold not reached' });

    const claimed = p.walk_weekly_claimed || 0;
    if (claimed & (1 << tier)) return res.status(400).json({ error: 'Already claimed' });

    const rewardDef = { ...WALK_WEEKLY_REWARDS[tier] };
    const granted = await grantReward(p, telegram_id, rewardDef);

    p.walk_weekly_claimed = claimed | (1 << tier);
    gameState.markDirty('players', p.id);

    await supabase.from('players').update({
      walk_weekly_claimed: p.walk_weekly_claimed,
    }).eq('id', p.id);

    return res.json({ success: true, tier, reward: granted });
  });
}
