/**
 * AI Analysis Service
 *
 * Uses Claude Opus 4.6 with adaptive thinking to:
 *   A) Analyze OHLC chart data → BUY / SELL / WAIT recommendation
 *   C) Suggest SL/TP levels based on price structure
 */
import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger.js';

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in environment');
  return new Anthropic({ apiKey });
}

// ── Helper: format OHLC bars into a compact text table ─────────────────────
function formatBars(bars, limit = 50) {
  const recent = bars.slice(-limit);
  const header = 'Time            | Open     | High     | Low      | Close    | Volume';
  const sep    = '-'.repeat(70);
  const rows = recent.map(b => {
    const t = new Date(b.time * 1000).toISOString().replace('T', ' ').slice(0, 16);
    return `${t} | ${b.open.toFixed(5).padStart(8)} | ${b.high.toFixed(5).padStart(8)} | ${b.low.toFixed(5).padStart(8)} | ${b.close.toFixed(5).padStart(8)} | ${String(b.tick_volume).padStart(6)}`;
  });
  return [header, sep, ...rows].join('\n');
}

// ── Helper: simple technical indicators ────────────────────────────────────
function calcIndicators(bars) {
  const closes = bars.map(b => b.close);
  const n = closes.length;
  if (n < 20) return {};

  // SMA 20, SMA 50
  const sma20 = closes.slice(-20).reduce((a, v) => a + v, 0) / 20;
  const sma50 = n >= 50 ? closes.slice(-50).reduce((a, v) => a + v, 0) / 50 : null;

  // ATR 14
  const atrBars = bars.slice(-15);
  let atrSum = 0;
  for (let i = 1; i < atrBars.length; i++) {
    const high = atrBars[i].high, low = atrBars[i].low, prevClose = atrBars[i - 1].close;
    atrSum += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  const atr14 = atrSum / 14;

  // Recent high/low (last 20 bars)
  const recent = bars.slice(-20);
  const recentHigh = Math.max(...recent.map(b => b.high));
  const recentLow  = Math.min(...recent.map(b => b.low));

  // RSI 14
  const gains = [], losses = [];
  const rsiSlice = closes.slice(-15);
  for (let i = 1; i < rsiSlice.length; i++) {
    const diff = rsiSlice[i] - rsiSlice[i - 1];
    if (diff >= 0) { gains.push(diff); losses.push(0); }
    else           { gains.push(0);    losses.push(-diff); }
  }
  const avgGain = gains.reduce((a, v) => a + v, 0) / gains.length;
  const avgLoss = losses.reduce((a, v) => a + v, 0) / losses.length;
  const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  return { sma20, sma50, atr14, recentHigh, recentLow, rsi: Math.round(rsi * 10) / 10 };
}

// ── Option A: Chart analysis → direction recommendation ────────────────────
export async function analyzeChart({ symbol, timeframe, bars, quote }) {
  const client = getClient();
  const indicators = calcIndicators(bars);
  const currentPrice = quote?.bid ?? bars[bars.length - 1]?.close;

  const systemPrompt = `You are an expert Forex and commodities technical analyst specializing in price action, support/resistance, and momentum analysis.
You analyze OHLC data and give clear, actionable trading recommendations.
Always respond with valid JSON only — no markdown, no extra text.`;

  const userPrompt = `Analyze the following ${timeframe} chart data for ${symbol} and provide a trading recommendation.

Current bid: ${currentPrice}

--- Technical Indicators ---
SMA 20: ${indicators.sma20?.toFixed(5) ?? 'N/A'}
SMA 50: ${indicators.sma50?.toFixed(5) ?? 'N/A'}
ATR 14: ${indicators.atr14?.toFixed(5) ?? 'N/A'}
RSI 14: ${indicators.rsi ?? 'N/A'}
Recent High (20 bars): ${indicators.recentHigh?.toFixed(5) ?? 'N/A'}
Recent Low  (20 bars): ${indicators.recentLow?.toFixed(5) ?? 'N/A'}

--- OHLC Data (last 50 bars) ---
${formatBars(bars, 50)}

Respond with JSON in this exact format:
{
  "direction": "BUY" | "SELL" | "WAIT",
  "confidence": 1-100,
  "trend": "UPTREND" | "DOWNTREND" | "RANGING",
  "key_levels": {
    "support": [price, ...],
    "resistance": [price, ...]
  },
  "reasoning": "2-4 sentences explaining the analysis",
  "caution": "any risk factors or conditions to watch"
}`;

  logger.info('ai_analyze_chart', { symbol, timeframe, bars: bars.length });

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  // Extract text block (after thinking)
  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text response from AI');

  try {
    return JSON.parse(textBlock.text);
  } catch {
    // Try to extract JSON if there's any extra text
    const match = textBlock.text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('AI response was not valid JSON: ' + textBlock.text.slice(0, 200));
  }
}

// ── Option C: Suggest SL/TP levels ────────────────────────────────────────
export async function suggestLevels({ symbol, side, entry, timeframe, bars, quote }) {
  const client = getClient();
  const indicators = calcIndicators(bars);

  const systemPrompt = `You are an expert risk management specialist for Forex and commodities trading.
You calculate precise SL (Stop Loss) and TP (Take Profit) levels based on market structure, ATR, and support/resistance.
Always respond with valid JSON only — no markdown, no extra text.`;

  const userPrompt = `Suggest SL and TP levels for the following trade:

Symbol: ${symbol}
Direction: ${side}
Entry Price: ${entry}
Timeframe: ${timeframe}

--- Technical Indicators ---
ATR 14: ${indicators.atr14?.toFixed(5) ?? 'N/A'}  (use for volatility-based stops)
SMA 20: ${indicators.sma20?.toFixed(5) ?? 'N/A'}
SMA 50: ${indicators.sma50?.toFixed(5) ?? 'N/A'}
RSI 14: ${indicators.rsi ?? 'N/A'}
Recent High (20 bars): ${indicators.recentHigh?.toFixed(5) ?? 'N/A'}
Recent Low  (20 bars): ${indicators.recentLow?.toFixed(5) ?? 'N/A'}

--- OHLC Data (last 50 bars) ---
${formatBars(bars, 50)}

Based on price structure and volatility, suggest optimal SL and TP levels.
Consider: key support/resistance, ATR-based stops, risk/reward ratio ≥ 1.5.

Respond with JSON in this exact format:
{
  "sl_price": number,
  "tp_price": number,
  "sl_pips": number,
  "tp_pips": number,
  "rr_ratio": number,
  "sl_basis": "why this SL placement",
  "tp_basis": "why this TP placement",
  "notes": "any additional context"
}`;

  logger.info('ai_suggest_levels', { symbol, side, entry, timeframe });

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    thinking: { type: 'adaptive' },
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text response from AI');

  try {
    return JSON.parse(textBlock.text);
  } catch {
    const match = textBlock.text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('AI response was not valid JSON: ' + textBlock.text.slice(0, 200));
  }
}
