import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { mt5 } from '../services/mt5Bridge.js';
import { analyzeChart, suggestLevels } from '../services/aiAnalysis.js';
import { logger } from '../services/logger.js';

const router = Router();

/**
 * POST /api/ai/analyze
 * Body: { symbol, timeframe? }
 * Returns: AI chart analysis with direction, confidence, key levels, reasoning
 *
 * Option A — AI analyzes OHLC data and recommends BUY / SELL / WAIT
 */
router.post('/analyze', requireAuth, async (req, res) => {
  const { symbol, timeframe = 'H1' } = req.body || {};
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });

  // Fetch OHLC data and current quote in parallel
  const [ohlcResult, quoteResult] = await Promise.all([
    mt5.ohlc(symbol, timeframe, 100),
    mt5.quote(symbol),
  ]);

  if (!ohlcResult.ok) return res.status(502).json({ error: 'Failed to fetch chart data: ' + ohlcResult.error });

  const bars  = ohlcResult.data.bars || [];
  const quote = quoteResult.ok ? quoteResult.data : null;

  if (bars.length < 20) {
    return res.status(422).json({ error: 'Not enough bar data for analysis (need at least 20)' });
  }

  logger.audit('ai_analyze_request', { symbol, timeframe, user: req.user.sub });

  try {
    const analysis = await analyzeChart({ symbol, timeframe, bars, quote });
    logger.info('ai_analyze_done', { symbol, direction: analysis.direction, confidence: analysis.confidence });
    res.json({ symbol, timeframe, quote, analysis, analyzed_at: new Date().toISOString() });
  } catch (err) {
    logger.error('ai_analyze_error', { symbol, msg: err.message });
    res.status(500).json({ error: 'AI analysis failed: ' + err.message });
  }
});

/**
 * POST /api/ai/suggest-levels
 * Body: { symbol, side, entry, timeframe? }
 * Returns: suggested SL/TP prices and pips, R:R ratio, reasoning
 *
 * Option C — AI recommends SL/TP before trade confirmation
 */
router.post('/suggest-levels', requireAuth, async (req, res) => {
  const { symbol, side, entry, timeframe = 'H1' } = req.body || {};
  if (!symbol || !side || !entry) {
    return res.status(400).json({ error: 'symbol, side, entry are required' });
  }
  if (!['BUY', 'SELL'].includes(side)) {
    return res.status(400).json({ error: 'side must be BUY or SELL' });
  }

  const ohlcResult = await mt5.ohlc(symbol, timeframe, 100);
  if (!ohlcResult.ok) return res.status(502).json({ error: 'Failed to fetch chart data: ' + ohlcResult.error });

  const bars = ohlcResult.data.bars || [];
  if (bars.length < 20) {
    return res.status(422).json({ error: 'Not enough bar data (need at least 20)' });
  }

  const quoteResult = await mt5.quote(symbol);
  const quote = quoteResult.ok ? quoteResult.data : null;

  logger.audit('ai_suggest_request', { symbol, side, entry, user: req.user.sub });

  try {
    const levels = await suggestLevels({ symbol, side, entry: Number(entry), timeframe, bars, quote });
    logger.info('ai_suggest_done', { symbol, side, sl_pips: levels.sl_pips, tp_pips: levels.tp_pips });
    res.json({ symbol, side, entry: Number(entry), timeframe, levels, suggested_at: new Date().toISOString() });
  } catch (err) {
    logger.error('ai_suggest_error', { symbol, msg: err.message });
    res.status(500).json({ error: 'AI level suggestion failed: ' + err.message });
  }
});

export default router;
