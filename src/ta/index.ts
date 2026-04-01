import axios from 'axios';
import { EMA, RSI, BollingerBands, ATR } from 'technicalindicators';
import { config, type Asset, ASSETS } from '../utils/config';
import { logger } from '../utils/logger';

export type Signal = 'LONG' | 'SHORT' | 'HOLD';
export type MarketRegime = 'TRENDING' | 'SIDEWAYS';

export interface TAResult {
  asset: Asset;
  signal: Signal;
  reason: string;
  confidence: number;
  currentPrice: number;
  rsi15m: number;
  trend4h: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  trend1h: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  regime: MarketRegime;
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

// ─── CryptoCompare OHLCV ─────────────────────────────────────────────────────

async function fetchOHLCV(asset: Asset, tf: '15m' | '1h' | '4h', limit = 60): Promise<Candle[]> {
  const isMinute = tf === '15m';
  const endpoint = isMinute ? 'histominute' : 'histohour';
  const aggregate = tf === '15m' ? 15 : tf === '1h' ? 1 : 4;

  const { data } = await axios.get(
    `https://min-api.cryptocompare.com/data/${endpoint}`,
    {
      params: { fsym: asset, tsym: 'USD', limit, aggregate, extraParams: 'jup-perps-agent' },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000,
    }
  );

  if (data.Response === 'Error') throw new Error(data.Message);
  return (data.Data || []).map((k: any) => ({
    open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volumefrom,
  }));
}

// ─── Market Regime Detection ──────────────────────────────────────────────────
// ATR-based: low ATR relative to price = sideways, high ATR = trending

function detectRegime(candles: Candle[]): MarketRegime {
  if (candles.length < 20) return 'TRENDING';

  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const closes = candles.map(c => c.close);

  const atrArr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  if (!atrArr.length) return 'TRENDING';

  const atr          = atrArr[atrArr.length - 1];
  const currentPrice = closes[closes.length - 1];
  const atrPct       = (atr / currentPrice) * 100;

  // ATR < 1.5% of price = low volatility = SIDEWAYS
  // ATR >= 1.5% = enough movement = TRENDING
  return atrPct < 1.5 ? 'SIDEWAYS' : 'TRENDING';
}

// ─── Bollinger Bands signal (for SIDEWAYS) ────────────────────────────────────

interface BBSignal {
  signal: Signal;
  reason: string;
  upper: number;
  lower: number;
  middle: number;
  bandwidth: number;  // (upper-lower)/middle = squeeze indicator
}

function analyzeBB(candles: Candle[], rsi: number): BBSignal {
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];

  const bbArr = BollingerBands.calculate({
    period: 20, stdDev: 2, values: closes,
  });

  if (!bbArr.length) return { signal: 'HOLD', reason: 'Insufficient BB data', upper: 0, lower: 0, middle: 0, bandwidth: 0 };

  const bb        = bbArr[bbArr.length - 1];
  const bandwidth = ((bb.upper - bb.lower) / bb.middle) * 100;

  let signal: Signal = 'HOLD';
  let reason = '';

  // Price at lower band + RSI not oversold → LONG (mean reversion)
  if (price <= bb.lower * 1.002 && rsi >= 30 && rsi <= 50) {
    signal = 'LONG';
    reason = `BB lower band touch | RSI: ${rsi.toFixed(1)} | BW: ${bandwidth.toFixed(1)}%`;
  }
  // Price at upper band + RSI not overbought → SHORT (mean reversion)
  else if (price >= bb.upper * 0.998 && rsi >= 50 && rsi <= 70) {
    signal = 'SHORT';
    reason = `BB upper band touch | RSI: ${rsi.toFixed(1)} | BW: ${bandwidth.toFixed(1)}%`;
  }

  return { signal, reason, upper: bb.upper, lower: bb.lower, middle: bb.middle, bandwidth };
}

// ─── EMA + RSI signal (for TRENDING) ─────────────────────────────────────────

interface TFResult {
  emaFast: number; emaSlow: number;
  emaFastPrev: number; emaSlowPrev: number;
  rsi: number; currentPrice: number;
  uptrend: boolean;
  bullishCross: boolean; bearishCross: boolean;
  volumeOk: boolean;
  higherHighs: boolean; lowerLows: boolean;
}

function calcTF(candles: Candle[]): TFResult | null {
  if (candles.length < 25) return null;
  const closes = candles.map(c => c.close);
  const fa = EMA.calculate({ period: config.ta.emaFast, values: closes });
  const sa = EMA.calculate({ period: config.ta.emaSlow, values: closes });
  const ra = RSI.calculate({ period: config.ta.rsiPeriod, values: closes });
  if (fa.length < 2 || sa.length < 2 || !ra.length) return null;

  const ef = fa[fa.length-1], efp = fa[fa.length-2];
  const es = sa[sa.length-1], esp = sa[sa.length-2];
  const avgVol = candles.slice(-11,-1).reduce((s,c) => s+c.volume, 0) / 10;
  const lb = config.ta.swingLookback;
  const rH = candles.slice(-lb).map(c=>c.high),   pH = candles.slice(-lb*2,-lb).map(c=>c.high);
  const rL = candles.slice(-lb).map(c=>c.low),    pL = candles.slice(-lb*2,-lb).map(c=>c.low);

  return {
    emaFast:ef, emaSlow:es, emaFastPrev:efp, emaSlowPrev:esp,
    rsi: ra[ra.length-1], currentPrice: closes[closes.length-1],
    uptrend: ef > es,
    bullishCross: efp<=esp && ef>es,
    bearishCross: efp>=esp && ef<es,
    volumeOk: candles[candles.length-1].volume >= avgVol * config.ta.volumeMultiplier,
    higherHighs: candles.length>=lb*2 ? Math.max(...rH)>Math.max(...pH) && Math.min(...rL)>Math.min(...pL) : false,
    lowerLows:   candles.length>=lb*2 ? Math.max(...rH)<Math.max(...pH) && Math.min(...rL)<Math.min(...pL) : false,
  };
}

// ─── ATR-based dynamic SL/TP ─────────────────────────────────────────────────

function calcATRSlTp(candles: Candle[], price: number, signal: Signal): { sl: number; tp: number } {
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const closes = candles.map(c => c.close);

  const atrArr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const atr    = atrArr.length ? atrArr[atrArr.length - 1] : price * 0.02;

  if (signal === 'LONG') {
    const sl = price - atr * 1.5;
    const tp = price + atr * 1.5 * config.ta.minRR;
    return { sl, tp };
  } else {
    const sl = price + atr * 1.5;
    const tp = price - atr * 1.5 * config.ta.minRR;
    return { sl, tp };
  }
}

// ─── Confidence scoring ───────────────────────────────────────────────────────

function calcConfidence(tf15m: TFResult, tf1h: TFResult, tf4h: TFResult, signal: Signal, regime: MarketRegime): number {
  let s = 0;
  if (signal === 'LONG') {
    if (tf4h.uptrend)  s+=20; if (tf1h.uptrend)  s+=15; if (tf15m.uptrend) s+=10;
    if (tf15m.rsi>=config.ta.rsiBuyMin && tf15m.rsi<=config.ta.rsiBuyMax) s+=20;
    else if (tf15m.rsi>=40 && tf15m.rsi<=65) s+=10;
    if (tf15m.volumeOk) s+=10; if (tf1h.higherHighs) s+=10; if (tf4h.higherHighs) s+=5;
    // bullishCross removed - not reliable with 40min interval
  } else {
    if (!tf4h.uptrend) s+=20; if (!tf1h.uptrend) s+=15; if (!tf15m.uptrend) s+=10;
    if (tf15m.rsi>=config.ta.rsiShortMin && tf15m.rsi<=config.ta.rsiShortMax) s+=20;
    else if (tf15m.rsi>=35 && tf15m.rsi<=65) s+=10;
    if (tf15m.volumeOk) s+=10; if (tf1h.lowerLows) s+=10; if (tf4h.lowerLows) s+=5;
    // bearishCross removed - not reliable with 40min interval
  }
  // Bonus: strategy matches regime
  if (regime === 'TRENDING') s += 5;
  return Math.max(0, Math.min(100, s));
}

// ─── Main analysis ────────────────────────────────────────────────────────────

export async function analyzeAsset(asset: Asset): Promise<TAResult | null> {
  try {
    logger.info(`Analyzing ${asset}...`);

    const c15m = await fetchOHLCV(asset, '15m', 60);
    await new Promise(r => setTimeout(r, 1000));
    const c1h  = await fetchOHLCV(asset, '1h',  60);
    await new Promise(r => setTimeout(r, 1000));
    const c4h  = await fetchOHLCV(asset, '4h',  60);

    const tf15m = calcTF(c15m);
    const tf1h  = calcTF(c1h);
    const tf4h  = calcTF(c4h);
    if (!tf15m||!tf1h||!tf4h) { logger.warn(`${asset}: insufficient data`); return null; }

    const price   = tf15m.currentPrice;
    const trend4h = tf4h.uptrend ? 'BULLISH' : 'BEARISH' as const;
    const trend1h = tf1h.uptrend ? 'BULLISH' : 'BEARISH' as const;

    // Detect market regime from 1h candles
    const regime = detectRegime(c1h);

    let signal: Signal = 'HOLD';
    let reason = '';
    let confidence = 0;

    if (regime === 'SIDEWAYS') {
      // ── Bollinger Bands strategy ────────────────────────────────────────
      const bb = analyzeBB(c15m, tf15m.rsi);
      signal = bb.signal;
      reason = `[SIDEWAYS] ${bb.reason}`;

      // Confidence for BB: based on how close to band + RSI confirmation
      if (signal !== 'HOLD') {
        confidence = 50; // base
        if (tf15m.rsi >= 30 && tf15m.rsi <= 70) confidence += 20;
        if (bb.bandwidth < 4) confidence += 15; // tight band = stronger mean reversion
        if (tf15m.volumeOk) confidence += 15;
        confidence = Math.min(100, confidence);
      }

      logger.info(`${asset} [SIDEWAYS] BB signal: ${signal} | bandwidth: ${analyzeBB(c15m, tf15m.rsi).bandwidth.toFixed(1)}%`);

    } else {
      // ── EMA + RSI strategy (trending) ──────────────────────────────────
      const allBullish = tf4h.uptrend && tf1h.uptrend;
      const allBearish = !tf4h.uptrend && !tf1h.uptrend;
      const longEntry  = tf15m.uptrend && tf15m.rsi>=config.ta.rsiBuyMin && tf15m.rsi<=config.ta.rsiBuyMax;
      const shortEntry = !tf15m.uptrend && tf15m.rsi>=config.ta.rsiShortMin && tf15m.rsi<=config.ta.rsiShortMax;

      if      (allBullish && longEntry)            signal = 'LONG';
      else if (allBearish && shortEntry)           signal = 'SHORT';
      else if (tf15m.rsi >= config.ta.rsiSellMin) signal = 'SHORT';
      else if (tf15m.rsi <= 30 && tf4h.uptrend)   signal = 'LONG';

      if (signal !== 'HOLD') {
        confidence = calcConfidence(tf15m, tf1h, tf4h, signal, regime);
        reason = `[TRENDING] ${trend4h}/${trend1h} | RSI ${tf15m.rsi.toFixed(1)} | ${confidence}% conf`;
      }
    }

    if (signal === 'HOLD') {
      logger.info(`${asset} → HOLD | ${regime} | RSI:${tf15m.rsi.toFixed(1)} | ${trend4h}/${trend1h}`);
      return {
        asset, signal:'HOLD', reason:`No signal (${regime})`, confidence:0,
        currentPrice:price, rsi15m:tf15m.rsi, trend4h, trend1h, regime,
        suggestedSL:0, suggestedTP:0, slPct:0, tpPct:0, rrRatio:0,
      };
    }

    // ATR-based SL/TP
    const { sl, tp } = calcATRSlTp(c15m, price, signal);
    const slDist = signal==='LONG' ? price-sl : sl-price;
    const tpDist = signal==='LONG' ? tp-price : price-tp;
    const rr     = tpDist / slDist;
    const slPct  = (slDist/price)*100;
    const tpPct  = (tpDist/price)*100;

    logger.info(`${asset} → ${signal} | ${regime} | conf:${confidence}% | RSI:${tf15m.rsi.toFixed(1)} | R:R:${rr.toFixed(2)}`);

    return {
      asset, signal, reason, confidence, currentPrice:price,
      rsi15m:tf15m.rsi, trend4h, trend1h, regime,
      suggestedSL:sl, suggestedTP:tp, slPct, tpPct, rrRatio:rr,
    };

  } catch (err: any) {
    logger.error(`${asset} analysis failed | ${err.message}`);
    return null;
  }
}

export async function analyzeAll(): Promise<TAResult[]> {
  const results: TAResult[] = [];
  for (const asset of ASSETS) {
    const r = await analyzeAsset(asset).catch(() => null);
    if (r) results.push(r);
    await new Promise(res => setTimeout(res, 3000));
  }
  return results;
}
