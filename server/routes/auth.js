import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../services/logger.js';

const router = Router();

/**
 * POST /api/auth/login
 * Body: { username, pin }
 * Returns: sets httpOnly cookie with JWT
 */
router.post('/login', (req, res) => {
  const { username, pin } = req.body || {};

  const validUser = process.env.ADMIN_USERNAME;
  const validPin = process.env.ADMIN_PIN;

  if (!username || !pin || username !== validUser || pin !== validPin) {
    logger.audit('login_failed', { username, ip: req.ip });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { sub: username, role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.SESSION_TTL || '8h' }
  );

  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000,
  });

  logger.audit('login_success', { username, ip: req.ip });
  res.json({ ok: true, username });
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  logger.audit('logout', { ip: req.ip });
  res.json({ ok: true });
});

export default router;
