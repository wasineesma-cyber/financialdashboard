/**
 * MT5 Bridge client
 *
 * Communicates with the Python mt5_bridge/bridge.py HTTP service.
 * All real order operations go through this layer.
 */
import axios from 'axios';
import { logger } from './logger.js';

const bridgeBase = () => process.env.MT5_BRIDGE_URL || 'http://localhost:8765';

async function call(method, path, data) {
  try {
    const fn = method === 'get' ? axios.get : axios.post;
    const resp = method === 'get'
      ? await axios.get(`${bridgeBase()}${path}`, { timeout: 10000 })
      : await axios.post(`${bridgeBase()}${path}`, data, { timeout: 10000 });
    return { ok: true, data: resp.data };
  } catch (err) {
    const msg = err.response?.data?.detail || err.message;
    logger.error('mt5_bridge_error', { path, msg });
    return { ok: false, error: msg };
  }
}

export const mt5 = {
  /**
   * POST /place_order
   * { symbol, order_type, lot, price?, sl, tp, magic, comment, idempotency_key }
   */
  placeOrder: (params) => call('post', '/place_order', params),

  /**
   * POST /modify_position
   * { ticket, sl?, tp? }
   */
  modifyPosition: (params) => call('post', '/modify_position', params),

  /**
   * POST /partial_close
   * { ticket, lot }
   */
  partialClose: (params) => call('post', '/partial_close', params),

  /**
   * POST /close_position
   * { ticket }
   */
  closePosition: (params) => call('post', '/close_position', params),

  /**
   * GET /sync_positions
   * Returns current open positions from MT5
   */
  syncPositions: () => call('get', '/sync_positions', null),

  /**
   * GET /account_info
   * Returns balance, equity, margin, free_margin, currency
   */
  accountInfo: () => call('get', '/account_info', null),

  /**
   * GET /quote/:symbol
   */
  quote: (symbol) => call('get', `/quote/${encodeURIComponent(symbol)}`, null),

  /**
   * GET /ohlc/:symbol?timeframe=H1&bars=200
   */
  ohlc: (symbol, timeframe = 'H1', bars = 200) =>
    call('get', `/ohlc/${encodeURIComponent(symbol)}?timeframe=${timeframe}&bars=${bars}`, null),

  /**
   * GET /health
   */
  health: () => call('get', '/health', null),
};
