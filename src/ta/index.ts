import axios from 'axios';
import { EMA, RSI, BollingerBands, ATR, ADX } from 'technicalindicators';
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
  adx: number;
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

async function fetchOHLCV(asset: Asset, tf: '15m' | '1h' | '4h', limit = 100): Promise<Candle[]> {
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
    open: k.open, high: k.high, low: k.low,
    close: k.close, volume: k.volumefrom,
  }));
}

// ─── Market Structure ─────────────────────────────────────────────────────────

function marketStructure(candles: Candle[]): { hh: boolean; ll: boolean } {
  if (candles.length < 10) return { hh: false, ll: false };
  const recent = candles.slice(-5);
  const prior  = candles.slice(-10, -5);
  const hh = Math.max(...recent.map(c => c.high)) > Math.max(...prior.map(c => c.high));
  const ll = Math.min(...recent.map(c => c.low))  < Math.min(...prior.map(c => c.low));
  return { hh, ll };
}

// ─── Regime Detection: ADX + ATR ─────────────────────────────────────────────

function detectRegime(candles: Candle[]): { regime: MarketRegime; adx: number } {
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const closes = candles.map(c => c.close);

  const adxArr = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
  const atrArr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });

  const adxVal = adxArr.length ? (adxArr[adxArr.length - 1].adx || 10) : 10;
  const atrVal = atrArr.length ? atrArr[atrArr.length - 1] : closes[closes.length - 1] * 0.02;
  const atrPct = (atrVal / closes[closes.length - 1]) * 100;

  const regime: MarketRegime = (adxVal > 20 && atrPct > 1) ? 'TRENDING' : 'SIDEWAYS';
  return { regime, adx: adxVal };
}

// ─── Trend Signal: EMA 20/50 + RSI + Market Structure ────────────────────────

interface TrendResult {
  signal: Signal;
  reason: string;
  rsi: number;
  emaFast: number;
  emaSlow: number;
  uptrend: boolean;
  volumeOk: boolean;
}

function trendSignal(candles: Candle[], rsiBuyMin: number, rsiBuyMax: number, rsiShortMin: number, rsiShortMax: number): TrendResult {
  const closes = candles.map(c => c.close);
  const emaFastArr = EMA.calculate({ period: 20, values: closes });
  const emaSlowArr = EMA.calculate({ period: 50, values: closes });
  const rsiArr     = RSI.calculate({ period: 14, values: closes });

  if (!emaFastArr.length || !emaSlowArr.length || !rsiArr.length) {
    return { signal: 'HOLD', reason: 'Insufficient data', rsi: 50, emaFast: 0, emaSlow: 0, uptrend: false, volumeOk: false };
  }

  const ef  = emaFastArr[emaFastArr.length - 1];
  const es  = emaSlowArr[emaSlowArr.length - 1];
  const rsi = rsiArr[rsiArr.length - 1];
  const avgVol   = candles.slice(-11, -1).reduce((s, c) => s + c.volume, 0) / 10;
  const volumeOk = candles[candles.length - 1].volume >= avgVol * config.ta.volumeMultiplier;
  const uptrend  = ef > es;
  const { hh, ll } = marketStructure(candles);

  let signal: Signal = 'HOLD';
  let reason = '';

  if (uptrend && hh && rsi >= rsiBuyMin && rsi <= rsiBuyMax) {
    signal = 'LONG';
    reason = `EMA20>50 ✓ | HH ✓ | RSI ${rsi.toFixed(1)}`;
  } else if (!uptrend && ll && rsi >= rsiShortMin && rsi <= rsiShortMax) {
    signal = 'SHORT';
    reason = `EMA20<50 ✓ | LL ✓ | RSI ${rsi.toFixed(1)}`;
  }

  return { signal, reason, rsi, emaFast: ef, emaSlow: es, uptrend, volumeOk };
}

// ─── BB Signal (SIDEWAYS) with STRICT macro trend filter ─────────────────────
// FIX: Only SHORT if 4h is also bearish (avoid shorting in bullish macro)
// FIX: Only LONG if 4h is also bullish (avoid longing in bearish macro)

interface BBResult {
  signal: Signal;
  reason: string;
  bandwidth: number;
}

function bbSignal(
  candles15m: Candle[],
  candles1h: Candle[],
  candles4h: Candle[],
  rsi: number
): BBResult {
  const closes = candles15m.map(c => c.close);
  const price  = closes[closes.length - 1];

  const bbArr = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
  if (!bbArr.length) return { signal: 'HOLD', reason: 'No BB data', bandwidth: 0 };

  const bb        = bbArr[bbArr.length - 1];
  const bandwidth = ((bb.upper - bb.lower) / bb.middle) * 100;

  // 1h trend
  const closes1h   = candles1h.map(c => c.close);
  const ema1hFast  = EMA.calculate({ period: 20, values: closes1h });
  const ema1hSlow  = EMA.calculate({ period: 50, values: closes1h });
  const trend1hUp  = ema1hFast.length && ema1hSlow.length
    ? ema1hFast[ema1hFast.length - 1] > ema1hSlow[ema1hSlow.length - 1]
    : true;

  // 4h trend — STRICT MACRO FILTER (NEW)
  const closes4h   = candles4h.map(c => c.close);
  const ema4hFast  = EMA.calculate({ period: 20, values: closes4h });
  const ema4hSlow  = EMA.calculate({ period: 50, values: closes4h });
  const trend4hUp  = ema4hFast.length && ema4hSlow.length
    ? ema4hFast[ema4hFast.length - 1] > ema4hSlow[ema4hSlow.length - 1]
    : true;

  let signal: Signal = 'HOLD';
  let reason = '';

  // LONG: price below middle + RSI 35-50
  // + 1h NOT strong downtrend
  // + 4h must be bullish or neutral (NEW — avoid longing in 4h downtrend)
  if (price < bb.middle && rsi > 35 && rsi < 50 && !(!trend1hUp && !trend4hUp)) {
    signal = 'LONG';
    reason = `BB below mid | RSI ${rsi.toFixed(1)} | 4h OK`;
  }
  // SHORT: price above middle + RSI 50-65
  // + 1h NOT strong uptrend
  // + 4h must be bearish (NEW — ONLY short if macro bearish too)
  else if (price > bb.middle && rsi < 65 && rsi > 50 && !trend1hUp && !trend4hUp) {
    signal = 'SHORT';
    reason = `BB above mid | RSI ${rsi.toFixed(1)} | 4h bearish confirmed`;
  }

  return { signal, reason, bandwidth };
}

// ─── ATR SL/TP ────────────────────────────────────────────────────────────────

function calcATRSlTp(candles: Candle[], price: number, signal: Signal) {
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const atrArr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const atr    = atrArr.length ? atrArr[atrArr.length - 1] : price * 0.02;

  if (signal === 'LONG') {
    return { sl: price - atr * 1.5, tp: price + atr * 1.5 * config.ta.minRR };
  } else {
    return { sl: price + atr * 1.5, tp: price - atr * 1.5 * config.ta.minRR };
  }
}

// ─── Confidence ───────────────────────────────────────────────────────────────

function calcConfidence(
  trend: TrendResult,
  tf4hUp: boolean,
  regime: MarketRegime,
  adx: number,
  signal: Signal
): number {
  let s = 0;
  if (signal === 'LONG') {
    if (tf4hUp)          s += 20;
    if (trend.uptrend)   s += 15;
    if (adx > 25)        s += 15; else if (adx > 20) s += 8;
    const rsi = trend.rsi;
    if (rsi >= 45 && rsi <= 60) s += 20; else if (rsi >= 40 && rsi <= 65) s += 10;
    if (trend.volumeOk)  s += 15;
    if (regime === 'TRENDING') s += 15;
  } else {
    if (!tf4hUp)         s += 20;
    if (!trend.uptrend)  s += 15;
    if (adx > 25)        s += 15; else if (adx > 20) s += 8;
    const rsi = trend.rsi;
    if (rsi >= 40 && rsi <= 55) s += 20; else if (rsi >= 35 && rsi <= 60) s += 10;
    if (trend.volumeOk)  s += 15;
    if (regime === 'TRENDING') s += 15;
  }
  return Math.max(0, Math.min(100, s));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function analyzeAsset(asset: Asset): Promise<TAResult | null> {
  try {
    logger.info(`Analyzing ${asset}...`);

    const c15m = await fetchOHLCV(asset, '15m', 100);
    await new Promise(r => setTimeout(r, 1000));
    const c1h  = await fetchOHLCV(asset, '1h',  100);
    await new Promise(r => setTimeout(r, 1000));
    const c4h  = await fetchOHLCV(asset, '4h',  100);

    if (c15m.length < 60 || c1h.length < 60 || c4h.length < 25) {
      logger.warn(`${asset}: insufficient candles`);
      return null;
    }

    const price = c15m[c15m.length - 1].close;
    const { regime, adx } = detectRegime(c1h);

    // 4h trend
    const ema4hFast = EMA.calculate({ period: 20, values: c4h.map(c => c.close) });
    const ema4hSlow = EMA.calculate({ period: 50, values: c4h.map(c => c.close) });
    const tf4hUp    = ema4hFast.length && ema4hSlow.length
      ? ema4hFast[ema4hFast.length - 1] > ema4hSlow[ema4hSlow.length - 1]
      : false;
    const trend4h   = tf4hUp ? 'BULLISH' : 'BEARISH' as const;

    const trend1hResult = trendSignal(c1h, config.ta.rsiBuyMin, config.ta.rsiBuyMax, config.ta.rsiShortMin, config.ta.rsiShortMax);
    const trend1h = trend1hResult.uptrend ? 'BULLISH' : 'BEARISH' as const;

    let signal: Signal = 'HOLD';
    let reason = '';
    let confidence = 0;
    let rsi15m = 50;

    if (regime === 'TRENDING') {
      const trend15m = trendSignal(c15m, config.ta.rsiBuyMin, config.ta.rsiBuyMax, config.ta.rsiShortMin, config.ta.rsiShortMax);
      rsi15m = trend15m.rsi;

      const allBullish = tf4hUp && trend1hResult.uptrend && trend15m.uptrend;
      const allBearish = !tf4hUp && !trend1hResult.uptrend && !trend15m.uptrend;

      if (allBullish && trend15m.rsi >= config.ta.rsiBuyMin && trend15m.rsi <= config.ta.rsiBuyMax) {
        signal = 'LONG';
        reason = `[TRENDING] ${trend15m.reason}`;
      } else if (allBearish && trend15m.rsi >= config.ta.rsiShortMin && trend15m.rsi <= config.ta.rsiShortMax) {
        signal = 'SHORT';
        reason = `[TRENDING] ${trend15m.reason}`;
      } else if (trend15m.rsi >= config.ta.rsiSellMin) {
        signal = 'SHORT';
        reason = `[TRENDING] RSI overbought ${trend15m.rsi.toFixed(1)}`;
      } else if (trend15m.rsi <= 30 && tf4hUp) {
        signal = 'LONG';
        reason = `[TRENDING] RSI oversold ${trend15m.rsi.toFixed(1)}`;
      }

      confidence = calcConfidence(trend15m, tf4hUp, regime, adx, signal !== 'HOLD' ? signal : (allBullish ? 'LONG' : 'SHORT'));

    } else {
      // SIDEWAYS — BB with STRICT 4h filter
      const rsiArr = RSI.calculate({ period: 14, values: c15m.map(c => c.close) });
      rsi15m = rsiArr.length ? rsiArr[rsiArr.length - 1] : 50;

      const bb = bbSignal(c15m, c1h, c4h, rsi15m);
      signal = bb.signal;
      reason = `[SIDEWAYS] ${bb.reason} | BW:${bb.bandwidth.toFixed(1)}%`;

      confidence = 30;
      if (rsi15m >= 35 && rsi15m <= 65) confidence += 15;
      if (adx < 20) confidence += 10;
      if (signal !== 'HOLD') confidence += 15;
      confidence = Math.min(100, confidence);
    }

    logger.info(`${asset} → ${signal} | ${regime} | ADX:${adx.toFixed(1)} | conf:${confidence}% | RSI:${rsi15m.toFixed(1)} | 4h:${trend4h} | 1h:${trend1h}`);

    if (signal === 'HOLD') {
      return {
        asset, signal: 'HOLD', reason: reason || `No signal (${regime})`,
        confidence, currentPrice: price, rsi15m, trend4h, trend1h,
        regime, adx,
        suggestedSL: 0, suggestedTP: 0, slPct: 0, tpPct: 0, rrRatio: 0,
      };
    }

    const { sl, tp } = calcATRSlTp(c15m, price, signal);
    const slDist = signal === 'LONG' ? price - sl : sl - price;
    const tpDist = signal === 'LONG' ? tp - price : price - tp;
    const rr     = tpDist / slDist;
    const slPct  = (slDist / price) * 100;
    const tpPct  = (tpDist / price) * 100;

    return {
      asset, signal, reason, confidence, currentPrice: price,
      rsi15m, trend4h, trend1h, regime, adx,
      suggestedSL: sl, suggestedTP: tp, slPct, tpPct, rrRatio: rr,
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
