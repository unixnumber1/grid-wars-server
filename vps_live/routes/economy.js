import { Router } from 'express';

export const economyRouter = Router();

// Economy routes are merged into buildings router (mine.js action:collect)
economyRouter.post('/', (req, res) => {
  res.status(400).json({ error: 'Use /api/buildings/mine with action:collect instead' });
});
