import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import authRouter from './routes/auth.js';
import sessionRouter from './routes/session.js';
import marketRouter from './routes/market.js';
import tradesRouter from './routes/trades.js';
import ordersRouter from './routes/orders.js';
import systemRouter from './routes/system.js';
import aiRouter from './routes/ai.js';
import { logger } from './services/logger.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// ── API Routes ──────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/session', sessionRouter);
app.use('/api/market', marketRouter);
app.use('/api/trades', tradesRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/system', systemRouter);
app.use('/api/ai', aiRouter);

// ── Serve static frontend ───────────────────────────────────────────────────
const publicDir = join(__dir, '..', 'public');
app.use(express.static(publicDir));
app.get('*', (_req, res) => res.sendFile(join(publicDir, 'index.html')));

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info('server_start', { port: PORT, env: process.env.NODE_ENV || 'development' });
  console.log(`FayeTradeX backend running on port ${PORT}`);
});
