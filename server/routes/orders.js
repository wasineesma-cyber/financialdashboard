import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { mt5 } from '../services/mt5Bridge.js';
import { upsertOrder, getOrder, getAllOrders, removeOrder, clearOrders } from '../services/orderStore.js';
import { logger } from '../services/logger.js';

const router = Router();

/**
 * GET /api/orders
 * Sync positions from MT5 and return merged state
 */
router.get('/', requireAuth, async (req, res) => {
  const sync = await mt5.syncPositions();
  if (sync.ok) {
    // Merge live MT5 data into store
    const live = sync.data.positions || [];
    clearOrders();
    for (const pos of live) {
      upsertOrder(pos.ticket, {
        ...pos,
        status: 'open',
      });
    }
  }
  res.json({ orders: getAllOrders(), synced: sync.ok });
});

/**
 * POST /api/orders/:id/breakeven
 * Move SL to entry price
 */
router.post('/:id/breakeven', requireAuth, async (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  logger.audit('breakeven_attempt', { ticket: order.ticket, user: req.user.sub });

  const result = await mt5.modifyPosition({
    ticket: order.ticket,
    sl: order.open_price ?? order.entry,
  });

  if (!result.ok) return res.status(502).json({ error: result.error });

  upsertOrder(order.ticket, { sl: order.open_price ?? order.entry, status: 'open' });
  logger.audit('breakeven_success', { ticket: order.ticket, user: req.user.sub });
  res.json({ ok: true, ...result.data });
});

/**
 * POST /api/orders/:id/partial-close
 * Body: { lot }
 */
router.post('/:id/partial-close', requireAuth, async (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const lot = Number(req.body?.lot);
  if (!lot || lot <= 0) return res.status(400).json({ error: 'lot must be positive' });

  logger.audit('partial_close_attempt', { ticket: order.ticket, lot, user: req.user.sub });

  const result = await mt5.partialClose({ ticket: order.ticket, lot });
  if (!result.ok) return res.status(502).json({ error: result.error });

  upsertOrder(order.ticket, { lot: (order.lot || 0) - lot, status: 'partially_closed' });
  logger.audit('partial_close_success', { ticket: order.ticket, lot, user: req.user.sub });
  res.json({ ok: true, ...result.data });
});

/**
 * POST /api/orders/:id/trailing
 * Body: { trail_pips }
 */
router.post('/:id/trailing', requireAuth, async (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const trailPips = Number(req.body?.trail_pips);
  if (!trailPips || trailPips <= 0) return res.status(400).json({ error: 'trail_pips must be positive' });

  logger.audit('trailing_attempt', { ticket: order.ticket, trailPips, user: req.user.sub });

  // Get current quote to compute new SL
  const quoteRes = await mt5.quote(order.symbol);
  if (!quoteRes.ok) return res.status(502).json({ error: 'Quote failed: ' + quoteRes.error });

  const { bid, ask, point } = quoteRes.data;
  const currentPrice = order.side === 'BUY' ? bid : ask;
  const newSl = order.side === 'BUY'
    ? parseFloat((currentPrice - trailPips * point).toFixed(5))
    : parseFloat((currentPrice + trailPips * point).toFixed(5));

  const result = await mt5.modifyPosition({ ticket: order.ticket, sl: newSl });
  if (!result.ok) return res.status(502).json({ error: result.error });

  upsertOrder(order.ticket, { sl: newSl });
  logger.audit('trailing_success', { ticket: order.ticket, newSl, user: req.user.sub });
  res.json({ ok: true, sl: newSl, ...result.data });
});

/**
 * POST /api/orders/:id/close
 */
router.post('/:id/close', requireAuth, async (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  logger.audit('close_attempt', { ticket: order.ticket, user: req.user.sub });

  const result = await mt5.closePosition({ ticket: order.ticket });
  if (!result.ok) return res.status(502).json({ error: result.error });

  upsertOrder(order.ticket, { status: 'closed', closeTime: new Date().toISOString() });
  logger.audit('close_success', { ticket: order.ticket, user: req.user.sub });
  res.json({ ok: true, ...result.data });
});

export default router;
