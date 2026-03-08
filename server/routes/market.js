import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { mt5 } from '../services/mt5Bridge.js';

const router = Router();

const DEFAULT_WATCHLIST = (process.env.WATCHLIST || 'XAUUSD,EURUSD,GBPUSD,US30,NAS100').split(',');

/**
 * GET /api/market/watchlist
 */
router.get('/watchlist', requireAuth, (req, res) => {
  res.json({ symbols: DEFAULT_WATCHLIST });
});

/**
 * GET /api/quotes/:symbol
 */
router.get('/quotes/:symbol', requireAuth, async (req, res) => {
  const result = await mt5.quote(req.params.symbol);
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json(result.data);
});

/**
 * GET /api/chart/:symbol?timeframe=H1&bars=200
 */
router.get('/chart/:symbol', requireAuth, async (req, res) => {
  const { timeframe = 'H1', bars = 200 } = req.query;
  const result = await mt5.ohlc(req.params.symbol, timeframe, Number(bars));
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json(result.data);
});

export default router;
