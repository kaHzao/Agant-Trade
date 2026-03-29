import axios from 'axios';
import { EMA, RSI } from 'technicalindicators';
import { config, type Asset, ASSETS } from '../utils/config';
import { logger } from '../utils/logger';

export type Signal = 'LONG' | 'SHORT' | 'HOLD';

export interface TAResult {
  asset: Asset;
  signal: Signal;
  reason: string;
  confidence: number;
  currentPrice: number;
  rsi15m: number;
  trend4h: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  trend1h: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  suggestedSL: number;
  suggestedTP: number;
  slPct: number;
  tpPct: number;
  rrRatio: number;
}

interface Candle {
  open: number; high: number; low: number;
  close: number; volume: number;
}

// ─── Binance public OHLCV (no API key needed) ────────────────────────────────

async function fetchOHLCV(asset: Asset, interval: string, limit = 60): Promise<Candle[]> {
  const symbol = config.binance.symbols[asset];
  const { data } = await axios.get(`${config.binance.baseUrl}/api/v3/klines`, {
    params: { symbol, interval, limit },
    timeout: 10000,
  });
  // Binance klines: [openTime, open, high, low, close, volume, ...]
  return data.map((k: any[]) => ({
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── TA helpers ──────────────────────────────────────────────────────────────

interface TFResult {
  emaFast: number; emaSlow: number;
  emaFastPrev: number; emaSlowPrev: number;
  rsi: number; currentPrice: number;
  uptrend: boolean; bullishCross: boolean; bearishCross: boolean;
  volumeOk: boolean; higherHighs: boolean;
}

function calcTF(candles: Candle[]): TFResult | null {
  if (candles.length < 25) return null;
  const closes = candles.map(c => c.close);
  const fa = EMA.calculate({ period: config.ta.emaFast, values: closes });
  const sa = EMA.calculate({ period: config.ta.emaSlow, values: closes });
  const ra = RSI.calculate({ period: config.ta.rsiPeriod, values: closes });
  if (fa.length < 2 || sa.length < 2 || !ra.length) return null;

  const ef = fa[fa.length - 1], efp = fa[fa.length - 2];
  const es = sa[sa.length - 1], esp = sa[sa.length - 2];

  const avgVol = candles.slice(-11, -1).reduce((s, c) => s + c.volume, 0) / 10;
  const volumeOk = candles[candles.length - 1].volume >= avgVol * config.ta.volumeMultiplier;

  const lb = config.ta.swingLookback;
  const higherHighs = candles.length >= lb * 2
    ? Math.max(...candles.slice(-lb).map(c => c.high)) > Math.max(...candles.slice(-lb * 2, -lb).map(c => c.high)) &&
      Math.min(...candles.slice(-lb).map(c => c.low))  > Math.min(...candles.slice(-lb * 2, -lb).map(c => c.low))
    : false;

  return {
    emaFast: ef, emaSlow: es, emaFastPrev: efp, emaSlowPrev: esp,
    rsi: ra[ra.length - 1], currentPrice: closes[closes.length - 1],
    uptrend: ef > es,
    bullishCross: efp <= esp && ef > es,
    bearishCross: efp >= esp && ef < es,
    volumeOk, higherHighs,
  };
}

function calcConfidence(tf15m: TFResult, tf1h: TFResult, tf4h: TFResult): number {
  let s = 0;
  if (tf4h.uptrend)     s += 20;
  if (tf1h.uptrend)     s += 15;
  if (tf15m.uptrend)    s += 10;
  if (tf15m.rsi >= 45 && tf15m.rsi <= 60) s += 20;
  else if (tf15m.rsi >= 40 && tf15m.rsi <= 65) s += 10;
  if (tf15m.volumeOk)   s += 10;
  if (tf1h.volumeOk)    s += 5;
  if (tf1h.higherHighs) s += 10;
  if (tf4h.higherHighs) s += 5;
  if (tf15m.bullishCross) s += 5;
  return Math.max(0, Math.min(100, s));
}

function swingLow(candles: Candle[], lb = 10): number {
  return Math.min(...candles.slice(-lb).map(c => c.low));
}
function swingHigh(candles: Candle[], lb = 30): number {
  return Math.max(...candles.slice(-lb).map(c => c.high));
}

// ─── Main analysis ────────────────────────────────────────────────────────────

export async function analyzeAsset(asset: Asset): Promise<TAResult | null> {
  try {
    logger.info(`Analyzing ${asset}...`);

    const [c15m, c1h, c4h] = await Promise.all([
      fetchOHLCV(asset, '15m', 60),
      fetchOHLCV(asset, '1h', 60),
      fetchOHLCV(asset, '4h', 60),
    ]);

    const tf15m = calcTF(c15m);
    const tf1h  = calcTF(c1h);
    const tf4h  = calcTF(c4h);

    if (!tf15m || !tf1h || !tf4h) {
      logger.warn(`${asset}: insufficient candle data`);
      return null;
    }

    const price    = tf15m.currentPrice;
    const trend4h  = tf4h.uptrend ? 'BULLISH' : 'BEARISH' as const;
    const trend1h  = tf1h.uptrend ? 'BULLISH' : 'BEARISH' as const;
    const conf     = calcConfidence(tf15m, tf1h, tf4h);

    // Dynamic SL/TP
    const sl     = swingLow(c15m, config.ta.swingLookback) * 0.995;
    const slDist = price - sl;
    const minTP  = price + slDist * config.ta.minRR;
    const tp     = Math.max(minTP, swingHigh(c1h) * 0.99);
    const rr     = (tp - price) / slDist;
    const slPct  = ((price - sl) / price) * 100;
    const tpPct  = ((tp - price) / price) * 100;

    // ── Signal ───────────────────────────────────────────────────────────
    let signal: Signal = 'HOLD';
    let reason = '';

    const allBullish = tf4h.uptrend && tf1h.uptrend;
    const entryOk = tf15m.bullishCross &&
      tf15m.rsi >= config.ta.rsiBuyMin &&
      tf15m.rsi <= config.ta.rsiBuyMax &&
      tf15m.volumeOk;
    const rrOk = rr >= config.ta.minRR;

    if (allBullish && entryOk && rrOk && conf >= config.ta.minConfidence) {
      signal = 'LONG';
      reason = `4h✓ 1h✓ 15m cross✓ | RSI ${tf15m.rsi.toFixed(1)} | R:R ${rr.toFixed(1)}x | ${conf}% conf`;
    } else if (
      (!tf4h.uptrend && !tf1h.uptrend) ||
      tf4h.bearishCross ||
      tf15m.rsi >= config.ta.rsiSellMin
    ) {
      signal = 'SHORT';
      reason = tf15m.rsi >= config.ta.rsiSellMin
        ? `RSI overbought ${tf15m.rsi.toFixed(1)}`
        : '4h + 1h bearish';
    }

    logger.info(`${asset} → ${signal} | conf:${conf}% | RSI:${tf15m.rsi.toFixed(1)} | trend4h:${trend4h} | trend1h:${trend1h} | R:R:${rr.toFixed(2)}`);

    return {
      asset, signal, reason, confidence: conf,
      currentPrice: price, rsi15m: tf15m.rsi,
      trend4h, trend1h,
      suggestedSL: sl, suggestedTP: tp,
      slPct, tpPct, rrRatio: rr,
    };

  } catch (err) {
    logger.error(`${asset} analysis failed`, err);
    return null;
  }
}

// ─── Run all 3 assets ─────────────────────────────────────────────────────────

export async function analyzeAll(): Promise<TAResult[]> {
  const results = await Promise.allSettled(ASSETS.map(analyzeAsset));
  return results
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .filter((r): r is TAResult => r !== null);
}
