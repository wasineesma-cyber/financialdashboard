import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../middleware/auth.js';
import { mt5 } from '../services/mt5Bridge.js';
import { upsertOrder } from '../services/orderStore.js';
import { logger } from '../services/logger.js';

const router = Router();

// Idempotency key cache (in-memory, v1)
const usedKeys = new Set();

/**
 * POST /api/trades/preview
 * Body: { symbol, side, lot, sl_pips, tp_pips }
 * Returns: calculated entry, sl, tp, estimated risk, margin
 */
router.post('/preview', requireAuth, async (req, res) => {
  const { symbol, side, lot, sl_pips, tp_pips } = req.body || {};

  if (!symbol || !side || !lot) {
    return res.status(400).json({ error: 'symbol, side, lot are required' });
  }
  if (!['BUY', 'SELL'].includes(side)) {
    return res.status(400).json({ error: 'side must be BUY or SELL' });
  }

  const quoteRes = await mt5.quote(symbol);
  if (!quoteRes.ok) return res.status(502).json({ error: 'Failed to get quote: ' + quoteRes.error });

  const { bid, ask, point, digits } = quoteRes.data;
  const entry = side === 'BUY' ? ask : bid;
  const slPips = Number(sl_pips) || 50;
  const tpPips = Number(tp_pips) || 100;
  const multiplier = side === 'BUY' ? 1 : -1;

  const sl = parseFloat((entry - multiplier * slPips * point).toFixed(digits));
  const tp = parseFloat((entry + multiplier * tpPips * point).toFixed(digits));

  // Approximate pip value (crude, bridge will calculate exact)
  const pipValuePerLot = 1 / point / 10;
  const estimatedRiskUSD = parseFloat((Number(lot) * slPips * point * pipValuePerLot).toFixed(2));

  logger.info('trade_preview', { symbol, side, lot, entry, sl, tp, user: req.user.sub });

  res.json({
    symbol,
    side,
    lot: Number(lot),
    entry,
    sl,
    tp,
    sl_pips: slPips,
    tp_pips: tpPips,
    estimated_risk_usd: estimatedRiskUSD,
    quote_time: new Date().toISOString(),
  });
});

/**
 * POST /api/trades/execute
 * Body: { symbol, side, lot, sl, tp, idempotency_key, comment? }
 */
router.post('/execute', requireAuth, async (req, res) => {
  const { symbol, side, lot, sl, tp, idempotency_key, comment } = req.body || {};

  if (!symbol || !side || !lot || !idempotency_key) {
    return res.status(400).json({ error: 'symbol, side, lot, idempotency_key are required' });
  }

  // Idempotency guard
  if (usedKeys.has(idempotency_key)) {
    logger.warn('duplicate_execute', { idempotency_key, user: req.user.sub });
    return res.status(409).json({ error: 'Duplicate request – order already submitted' });
  }
  usedKeys.add(idempotency_key);

  const magic = parseInt(process.env.MT5_MAGIC || '20240001');

  logger.audit('trade_execute_attempt', { symbol, side, lot, sl, tp, user: req.user.sub, idempotency_key });

  const result = await mt5.placeOrder({
    symbol,
    order_type: side,
    lot: Number(lot),
    sl: sl ? Number(sl) : undefined,
    tp: tp ? Number(tp) : undefined,
    magic,
    comment: comment || 'FayeTradeX',
    idempotency_key,
  });

  if (!result.ok) {
    usedKeys.delete(idempotency_key); // allow retry on bridge error
    logger.audit('trade_execute_failed', { symbol, side, error: result.error, user: req.user.sub });
    return res.status(502).json({ error: result.error });
  }

  const ticket = result.data.ticket;
  upsertOrder(ticket, {
    ticket,
    symbol,
    side,
    lot: Number(lot),
    sl,
    tp,
    status: 'submitted',
    openTime: new Date().toISOString(),
    idempotency_key,
    user: req.user.sub,
  });

  logger.audit('trade_execute_success', { ticket, symbol, side, lot, user: req.user.sub });
  res.json({ ok: true, ticket, ...result.data });
});

export default router;
