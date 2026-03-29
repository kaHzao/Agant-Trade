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

// ─── CoinGecko IDs ───────────────────────────────────────────────────────────

const COINGECKO_IDS: Record<Asset, string> = {
  SOL: 'solana',
  BTC: 'bitcoin',
  ETH: 'ethereum',
};

// CoinGecko interval mapping → days needed
const TF_CONFIG = {
  '15m': { days: 1,   interval: 'minutely' },
  '1h':  { days: 2,   interval: 'hourly'   },
  '4h':  { days: 14,  interval: 'hourly'   },
};

// ─── Fetch OHLCV from CoinGecko (free, no key, no geo-block) ─────────────────

async function fetchOHLCV(asset: Asset, tf: '15m' | '1h' | '4h', limit = 60): Promise<Candle[]> {
  const id = COINGECKO_IDS[asset];
  const { days } = TF_CONFIG[tf];

  const { data } = await axios.get(
    `https://api.coingecko.com/api/v3/coins/${id}/ohlc`,
    {
      params: { vs_currency: 'usd', days },
      headers: { 'Accept': 'application/json' },
      timeout: 15000,
    }
  );

  // CoinGecko OHLC: [timestamp, open, high, low, close]
  // No volume in free tier — set to 1 (volume check will be skipped)
  const candles: Candle[] = data.map((k: number[]) => ({
    open:   k[1],
    high:   k[2],
    low:    k[3],
    close:  k[4],
    volume: 1,
  }));

  // Return last `limit` candles
  return candles.slice(-limit);
}

// ─── TA helpers ──────────────────────────────────────────────────────────────

interface TFResult {
  emaFast: number; emaSlow: number;
  emaFastPrev: number; emaSlowPrev: number;
  rsi: number; currentPrice: number;
  uptrend: boolean;
  bullishCross: boolean; bearishCross: boolean;
  higherHighs: boolean; lowerLows: boolean;
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

  const lb = config.ta.swingLookback;
  const recentHighs  = candles.slice(-lb).map(c => c.high);
  const priorHighs   = candles.slice(-lb * 2, -lb).map(c => c.high);
  const recentLows   = candles.slice(-lb).map(c => c.low);
  const priorLows    = candles.slice(-lb * 2, -lb).map(c => c.low);

  const higherHighs = candles.length >= lb * 2
    ? Math.max(...recentHighs) > Math.max(...priorHighs) &&
      Math.min(...recentLows)  > Math.min(...priorLows)
    : false;

  const lowerLows = candles.length >= lb * 2
    ? Math.max(...recentHighs) < Math.max(...priorHighs) &&
      Math.min(...recentLows)  < Math.min(...priorLows)
    : false;

  return {
    emaFast: ef, emaSlow: es, emaFastPrev: efp, emaSlowPrev: esp,
    rsi: ra[ra.length - 1],
    currentPrice: closes[closes.length - 1],
    uptrend: ef > es,
    bullishCross: efp <= esp && ef > es,
    bearishCross: efp >= esp && ef < es,
    higherHighs, lowerLows,
  };
}

// ─── Confidence score — balanced for LONG and SHORT ──────────────────────────

function calcConfidence(tf15m: TFResult, tf1h: TFResult, tf4h: TFResult, signal: Signal): number {
  let s = 0;

  if (signal === 'LONG') {
    if (tf4h.uptrend)      s += 20;
    if (tf1h.uptrend)      s += 15;
    if (tf15m.uptrend)     s += 10;
    if (tf15m.rsi >= 45 && tf15m.rsi <= 60) s += 20;
    else if (tf15m.rsi >= 40 && tf15m.rsi <= 65) s += 10;
    if (tf1h.higherHighs)  s += 10;
    if (tf4h.higherHighs)  s += 10;
    if (tf15m.bullishCross) s += 15;
  } else {
    // SHORT scoring — mirror of LONG
    if (!tf4h.uptrend)     s += 20;
    if (!tf1h.uptrend)     s += 15;
    if (!tf15m.uptrend)    s += 10;
    if (tf15m.rsi >= 40 && tf15m.rsi <= 55) s += 20;
    else if (tf15m.rsi >= 35 && tf15m.rsi <= 60) s += 10;
    if (tf1h.lowerLows)    s += 10;
    if (tf4h.lowerLows)    s += 10;
    if (tf15m.bearishCross) s += 15;
  }

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

    // CoinGecko free tier has rate limit — stagger requests
    const c15m = await fetchOHLCV(asset, '15m', 60);
    await new Promise(r => setTimeout(r, 1500));
    const c1h  = await fetchOHLCV(asset, '1h', 60);
    await new Promise(r => setTimeout(r, 1500));
    const c4h  = await fetchOHLCV(asset, '4h', 60);

    const tf15m = calcTF(c15m);
    const tf1h  = calcTF(c1h);
    const tf4h  = calcTF(c4h);

    if (!tf15m || !tf1h || !tf4h) {
      logger.warn(`${asset}: insufficient candle data`);
      return null;
    }

    const price   = tf15m.currentPrice;
    const trend4h = tf4h.uptrend ? 'BULLISH' : 'BEARISH' as const;
    const trend1h = tf1h.uptrend ? 'BULLISH' : 'BEARISH' as const;

    // ── Determine signal direction first ──────────────────────────────────
    let signal: Signal = 'HOLD';
    let reason = '';

    const allBullish  = tf4h.uptrend && tf1h.uptrend;
    const allBearish  = !tf4h.uptrend && !tf1h.uptrend;
    const longEntry   = tf15m.bullishCross && tf15m.rsi >= config.ta.rsiBuyMin && tf15m.rsi <= config.ta.rsiBuyMax;
    const shortEntry  = tf15m.bearishCross && tf15m.rsi >= 35 && tf15m.rsi <= 60;
    const overbought  = tf15m.rsi >= config.ta.rsiSellMin;
    const oversold    = tf15m.rsi <= 30;

    if (allBullish && longEntry) {
      signal = 'LONG';
    } else if (allBearish && shortEntry) {
      signal = 'SHORT';
    } else if (overbought) {
      signal = 'SHORT';
    } else if (oversold && tf4h.uptrend) {
      signal = 'LONG';
    }

    if (signal === 'HOLD') {
      logger.info(`${asset} → HOLD | RSI:${tf15m.rsi.toFixed(1)} | trend4h:${trend4h} | trend1h:${trend1h}`);
      return {
        asset, signal: 'HOLD', reason: 'No clear signal',
        confidence: 0, currentPrice: price, rsi15m: tf15m.rsi,
        trend4h, trend1h,
        suggestedSL: 0, suggestedTP: 0, slPct: 0, tpPct: 0, rrRatio: 0,
      };
    }

    // ── Confidence with signal-aware scoring ──────────────────────────────
    const conf = calcConfidence(tf15m, tf1h, tf4h, signal);

    // ── Dynamic SL/TP ─────────────────────────────────────────────────────
    let sl: number, tp: number;

    if (signal === 'LONG') {
      sl = swingLow(c15m, config.ta.swingLookback) * 0.995;
      const slDist = price - sl;
      tp = Math.max(price + slDist * config.ta.minRR, swingHigh(c1h) * 0.99);
    } else {
      sl = swingHigh(c15m, config.ta.swingLookback) * 1.005;
      const slDist = sl - price;
      tp = Math.min(price - slDist * config.ta.minRR, swingLow(c1h) * 1.01);
    }

    const slDist = signal === 'LONG' ? price - sl : sl - price;
    const tpDist = signal === 'LONG' ? tp - price : price - tp;
    const rr     = tpDist / slDist;
    const slPct  = (slDist / price) * 100;
    const tpPct  = (tpDist / price) * 100;

    if (signal === 'LONG') {
      reason = `4h✓ 1h✓ 15m cross✓ | RSI ${tf15m.rsi.toFixed(1)} | R:R ${rr.toFixed(1)}x | ${conf}%`;
    } else {
      reason = `4h✓ 1h✓ 15m bearish | RSI ${tf15m.rsi.toFixed(1)} | R:R ${rr.toFixed(1)}x | ${conf}%`;
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

export async function analyzeAll(): Promise<TAResult[]> {
  const results: TAResult[] = [];
  // Sequential to respect CoinGecko rate limit
  for (const asset of ASSETS) {
    const r = await analyzeAsset(asset);
    if (r) results.push(r);
    await new Promise(res => setTimeout(res, 2000));
  }
  return results;
}
