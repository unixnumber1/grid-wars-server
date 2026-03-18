import { Router } from 'express';

export const shopRouter = Router();

// Shop routes are merged into items router (open-box action)
shopRouter.post('/', (req, res) => {
  res.status(400).json({ error: 'Use /api/items with action:open-box instead' });
});
