import { Router } from 'express';
import { gameState } from '../../game/state/GameState.js';
import { handleGet, handleInvest, handleReset, handleActivateShadow } from '../../game/mechanics/skills.js';
import { withPlayerLock } from '../../lib/playerLock.js';

export const skillsRouter = Router();

skillsRouter.post('/', async (req, res) => {
  const { telegram_id, action } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'Missing telegram_id' });

  // 'get' is read-only — skip the lock to avoid blocking concurrent reads.
  const skipLock = action === 'get';
  const handler = async () => {
    try {
      const player = gameState.getPlayerByTgId(telegram_id);
      if (!player) return res.status(404).json({ error: 'Player not found' });

      let result;
      switch (action) {
        case 'get':              result = await handleGet(req.body, player); break;
        case 'invest':           result = await handleInvest(req.body, player); break;
        case 'reset':            result = await handleReset(req.body, player); break;
        case 'activate-shadow':  result = await handleActivateShadow(req.body, player); break;
        default:                 return res.status(400).json({ error: 'Unknown action' });
      }

      if (result.status) {
        const { status, ...rest } = result;
        return res.status(status).json(rest);
      }
      return res.json(result);
    } catch (err) {
      console.error('[skills] error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  };

  if (skipLock) return handler();
  return withPlayerLock(telegram_id, handler);
});
