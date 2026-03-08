import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { mt5 } from '../services/mt5Bridge.js';

const router = Router();

/**
 * GET /api/system/health
 * Check connectivity of all subsystems
 */
router.get('/health', requireAuth, async (req, res) => {
  const mt5Health = await mt5.health();

  const status = {
    mt5: mt5Health.ok ? 'connected' : 'disconnected',
    mt5_detail: mt5Health.ok ? mt5Health.data : mt5Health.error,
    api: 'connected',
    timestamp: new Date().toISOString(),
  };

  const allOk = mt5Health.ok;
  res.status(allOk ? 200 : 207).json(status);
});

export default router;
