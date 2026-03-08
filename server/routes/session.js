import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { mt5 } from '../services/mt5Bridge.js';

const router = Router();

/**
 * GET /api/session
 * Returns current user info + account snapshot
 */
router.get('/', requireAuth, async (req, res) => {
  const acct = await mt5.accountInfo();
  res.json({
    user: req.user.sub,
    role: req.user.role,
    account: acct.ok ? acct.data : null,
  });
});

export default router;
