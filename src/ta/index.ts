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

// ─── Fetch OHLCV ─────────────────────────────────────────────────────────────

async function fetchOHLCV(asset: Asset, tf: '30m' | '1h' | '4h', limit = 100): Promise<Candle[]> {
  const endpoint = tf === '30m' ? 'histominute' : 'histohour';
  const aggregate = tf === '30m' ? 30 : tf === '1h' ? 1 : 4;

  const { data } = await axios.get(
    `https://min-api.cryptocompare.com/data/${endpoint}`,
    {
      params: { fsym: asset, tsym: 'USD', limit, aggregate },
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

// ─── EMA Trend Direction ──────────────────────────────────────────────────────

function emaUptrend(candles: Candle[]): boolean {
  const closes = candles.map(c => c.close);
  const fast = EMA.calculate({ period: 20, values: closes });
  const slow = EMA.calculate({ period: 50, values: closes });
  if (!fast.length || !slow.length) return false;
  return fast[fast.length - 1] > slow[slow.length - 1];
}

// ─── RSI ──────────────────────────────────────────────────────────────────────

function getRSI(candles: Candle[]): number {
  const rsiArr = RSI.calculate({ period: 14, values: candles.map(c => c.close) });
  return rsiArr.length ? rsiArr[rsiArr.length - 1] : 50;
}

// ─── ADX ──────────────────────────────────────────────────────────────────────

function getADX(candles: Candle[]): number {
  const adxArr = ADX.calculate({
    period: 14,
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: candles.map(c => c.close),
  });
  return adxArr.length ? (adxArr[adxArr.length - 1].adx || 10) : 10;
}

// ─── ATR SL/TP ────────────────────────────────────────────────────────────────

function calcATRSlTp(candles: Candle[], price: number, signal: Signal) {
  const atrArr = ATR.calculate({
    period: 14,
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: candles.map(c => c.close),
  });
  const atr = atrArr.length ? atrArr[atrArr.length - 1] : price * 0.02;

  if (signal === 'LONG') {
    return { sl: price - atr * 1.0, tp: price + atr * 1.0 * config.ta.minRR };
  } else {
    return { sl: price + atr * 1.0, tp: price - atr * 1.0 * config.ta.minRR };
  }
}

// ─── Volume OK ────────────────────────────────────────────────────────────────

function volumeOk(candles: Candle[]): boolean {
  const avgVol = candles.slice(-11, -1).reduce((s, c) => s + c.volume, 0) / 10;
  return candles[candles.length - 1].volume >= avgVol * config.ta.volumeMultiplier;
}

// ─── Confidence Score ─────────────────────────────────────────────────────────

function calcConfidence(
  signal: Signal,
  tf4hUp: boolean,
  tf1hUp: boolean,
  tf30mUp: boolean,
  rsi: number,
  adx: number,
  volOk: boolean
): number {
  let score = 0;

  if (signal === 'LONG') {
    // TF alignment
    if (tf4hUp)  score += 25;  // 4h bullish — wajib
    if (tf1hUp)  score += 25;  // 1h bullish — wajib
    if (tf30mUp) score += 15;  // 30m bullish — bonus

    // RSI in ideal zone
    if (rsi >= 45 && rsi <= 58) score += 20;
    else if (rsi >= 40 && rsi <= 62) score += 10;

    // ADX trend strength
    if (adx > 25) score += 10;
    else if (adx > 20) score += 5;

    // Volume
    if (volOk) score += 5;

  } else { // SHORT
    if (!tf4hUp)  score += 25;
    if (!tf1hUp)  score += 25;
    if (!tf30mUp) score += 15;

    if (rsi >= 42 && rsi <= 55) score += 20;
    else if (rsi >= 38 && rsi <= 60) score += 10;

    if (adx > 25) score += 10;
    else if (adx > 20) score += 5;

    if (volOk) score += 5;
  }

  return Math.min(100, score);
}

// ─── Main Analysis ────────────────────────────────────────────────────────────

export async function analyzeAsset(asset: Asset): Promise<TAResult | null> {
  try {
    logger.info(`Analyzing ${asset}...`);

    // Fetch 3 timeframes
    const c30m = await fetchOHLCV(asset, '30m', 100);
    await new Promise(r => setTimeout(r, 1000));
    const c1h  = await fetchOHLCV(asset, '1h',  100);
    await new Promise(r => setTimeout(r, 1000));
    const c4h  = await fetchOHLCV(asset, '4h',  100);

    if (c30m.length < 60 || c1h.length < 60 || c4h.length < 25) {
      logger.warn(`${asset}: insufficient candles`);
      return null;
    }

    const price = c30m[c30m.length - 1].close;

    // ── Trend direction per TF ──────────────────────────────────────────────
    const tf4hUp  = emaUptrend(c4h);
    const tf1hUp  = emaUptrend(c1h);
    const tf30mUp = emaUptrend(c30m);

    const trend4h = tf4hUp  ? 'BULLISH' : 'BEARISH' as const;
    const trend1h = tf1hUp  ? 'BULLISH' : 'BEARISH' as const;

    // ── ADX from 1h ────────────────────────────────────────────────────────
    const adx = getADX(c1h);
    const regime: MarketRegime = adx > 20 ? 'TRENDING' : 'SIDEWAYS';

    // ── RSI from 30m ───────────────────────────────────────────────────────
    const rsi = getRSI(c30m);

    // ── Volume ─────────────────────────────────────────────────────────────
    const volOk = volumeOk(c30m);

    // ══════════════════════════════════════════════════════════════════════
    // CORE LOGIC — STRICT ALIGNMENT RULE
    // 4h + 1h MUST agree → konflik = HOLD PAKSA
    // ══════════════════════════════════════════════════════════════════════

    let signal: Signal = 'HOLD';
    let reason = '';

    const conflict = tf4hUp !== tf1hUp; // 4h vs 1h disagree

    if (conflict) {
      // ── KONFLIK = HOLD PAKSA ─────────────────────────────────────────────
      reason = `KONFLIK: 4h ${trend4h} vs 1h ${trend1h} → HOLD PAKSA`;

    } else if (tf4hUp && tf1hUp) {
      // ── BOTH BULLISH → cek LONG ──────────────────────────────────────────
      // RSI harus 40-60 (tidak overbought)
      if (rsi >= 40 && rsi <= 60) {
        // 30m sebagai timing — 2 dari 3 TF bullish = cukup (sudah terpenuhi 4h+1h)
        signal = 'LONG';
        reason = `4h✅ 1h✅ 30m:${tf30mUp ? '✅' : '⚠️'} | RSI:${rsi.toFixed(1)}`;
      } else if (rsi > 60) {
        reason = `4h+1h BULLISH tapi RSI terlalu tinggi (${rsi.toFixed(1)}) → tunggu pullback`;
      } else {
        reason = `4h+1h BULLISH tapi RSI terlalu rendah (${rsi.toFixed(1)})`;
      }

    } else if (!tf4hUp && !tf1hUp) {
      // ── BOTH BEARISH → cek SHORT ─────────────────────────────────────────
      // RSI harus 40-60 (tidak oversold)
      if (rsi >= 40 && rsi <= 60) {
        signal = 'SHORT';
        reason = `4h✅ 1h✅ 30m:${!tf30mUp ? '✅' : '⚠️'} | RSI:${rsi.toFixed(1)}`;
      } else if (rsi < 40) {
        reason = `4h+1h BEARISH tapi RSI terlalu rendah (${rsi.toFixed(1)}) → tunggu bounce`;
      } else {
        reason = `4h+1h BEARISH tapi RSI terlalu tinggi (${rsi.toFixed(1)})`;
      }
    }

    // ── Confidence ─────────────────────────────────────────────────────────
    const confidence = signal !== 'HOLD'
      ? calcConfidence(signal, tf4hUp, tf1hUp, tf30mUp, rsi, adx, volOk)
      : 0;

    // ── Hard confidence gate ────────────────────────────────────────────────
    if (signal !== 'HOLD' && confidence < config.ta.minConfidence) {
      reason = `${signal} blocked — confidence too low (${confidence}% < ${config.ta.minConfidence}%)`;
      signal = 'HOLD';
    }

    logger.info(
      `${asset} → ${signal} | ${regime} | ADX:${adx.toFixed(1)} | conf:${confidence}% | ` +
      `RSI:${rsi.toFixed(1)} | 4h:${trend4h} | 1h:${trend1h} | 30m:${tf30mUp ? 'UP' : 'DOWN'}`
    );

    if (signal === 'HOLD') {
      return {
        asset, signal: 'HOLD', reason,
        confidence, currentPrice: price, rsi15m: rsi,
        trend4h, trend1h, regime, adx,
        suggestedSL: 0, suggestedTP: 0, slPct: 0, tpPct: 0, rrRatio: 0,
      };
    }

    // ── SL/TP ───────────────────────────────────────────────────────────────
    const { sl, tp } = calcATRSlTp(c30m, price, signal);
    const slDist = signal === 'LONG' ? price - sl : sl - price;
    const tpDist = signal === 'LONG' ? tp - price : price - tp;
    const rr     = tpDist / slDist;
    const slPct  = (slDist / price) * 100;
    const tpPct  = (tpDist / price) * 100;

    // ── Minimum R:R gate ────────────────────────────────────────────────────
    if (rr < config.ta.minRR - 0.01) {
      logger.info(`${asset}: R:R too low (${rr.toFixed(2)} < ${config.ta.minRR}) → HOLD`);
      return {
        asset, signal: 'HOLD',
        reason: `R:R too low (${rr.toFixed(2)})`,
        confidence, currentPrice: price, rsi15m: rsi,
        trend4h, trend1h, regime, adx,
        suggestedSL: 0, suggestedTP: 0, slPct: 0, tpPct: 0, rrRatio: rr,
      };
    }

    return {
      asset, signal, reason, confidence, currentPrice: price,
      rsi15m: rsi, trend4h, trend1h, regime, adx,
      suggestedSL: sl, suggestedTP: tp, slPct, tpPct, rrRatio: rr,
    };

  } catch (err: any) {
    logger.error(`${asset} analysis failed: ${err.message}`);
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
