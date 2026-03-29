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

// ─── CryptoCompare (confirmed 200 from GitHub Actions) ───────────────────────

async function fetchOHLCV(asset: Asset, tf: '15m' | '1h' | '4h', limit = 60): Promise<Candle[]> {
  // CryptoCompare: histominute for 15m, histohour for 1h/4h
  const isMinute = tf === '15m';
  const endpoint = isMinute ? 'histominute' : 'histohour';
  const aggregate = tf === '15m' ? 15 : tf === '1h' ? 1 : 4;

  const { data } = await axios.get(
    `https://min-api.cryptocompare.com/data/${endpoint}`,
    {
      params: {
        fsym: asset,      // SOL, BTC, ETH
        tsym: 'USD',
        limit,
        aggregate,
        extraParams: 'jup-perps-agent',
      },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000,
    }
  );

  if (data.Response === 'Error') throw new Error(data.Message);

  return (data.Data || []).map((k: any) => ({
    open:   k.open,
    high:   k.high,
    low:    k.low,
    close:  k.close,
    volume: k.volumefrom,
  }));
}

// ─── TA helpers ──────────────────────────────────────────────────────────────

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
  const volumeOk = candles[candles.length-1].volume >= avgVol * config.ta.volumeMultiplier;

  const lb = config.ta.swingLookback;
  const rH = candles.slice(-lb).map(c=>c.high),   pH = candles.slice(-lb*2,-lb).map(c=>c.high);
  const rL = candles.slice(-lb).map(c=>c.low),    pL = candles.slice(-lb*2,-lb).map(c=>c.low);
  const higherHighs = candles.length >= lb*2
    ? Math.max(...rH) > Math.max(...pH) && Math.min(...rL) > Math.min(...pL) : false;
  const lowerLows = candles.length >= lb*2
    ? Math.max(...rH) < Math.max(...pH) && Math.min(...rL) < Math.min(...pL) : false;

  return {
    emaFast:ef, emaSlow:es, emaFastPrev:efp, emaSlowPrev:esp,
    rsi: ra[ra.length-1], currentPrice: closes[closes.length-1],
    uptrend: ef > es,
    bullishCross: efp<=esp && ef>es,
    bearishCross: efp>=esp && ef<es,
    volumeOk, higherHighs, lowerLows,
  };
}

function calcConfidence(tf15m: TFResult, tf1h: TFResult, tf4h: TFResult, signal: Signal): number {
  let s = 0;
  if (signal === 'LONG') {
    if (tf4h.uptrend)  s+=20; if (tf1h.uptrend)  s+=15; if (tf15m.uptrend) s+=10;
    if (tf15m.rsi>=45&&tf15m.rsi<=60) s+=20;
    else if (tf15m.rsi>=40&&tf15m.rsi<=65) s+=10;
    if (tf15m.volumeOk) s+=10; if (tf1h.higherHighs) s+=10; if (tf4h.higherHighs) s+=5;
    if (tf15m.bullishCross) s+=10;
  } else {
    if (!tf4h.uptrend) s+=20; if (!tf1h.uptrend) s+=15; if (!tf15m.uptrend) s+=10;
    if (tf15m.rsi>=40&&tf15m.rsi<=55) s+=20;
    else if (tf15m.rsi>=35&&tf15m.rsi<=60) s+=10;
    if (tf15m.volumeOk) s+=10; if (tf1h.lowerLows) s+=10; if (tf4h.lowerLows) s+=5;
    if (tf15m.bearishCross) s+=10;
  }
  return Math.max(0, Math.min(100, s));
}

function swingLow(c: Candle[], lb=10)  { return Math.min(...c.slice(-lb).map(x=>x.low)); }
function swingHigh(c: Candle[], lb=30) { return Math.max(...c.slice(-lb).map(x=>x.high)); }

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function analyzeAsset(asset: Asset): Promise<TAResult | null> {
  try {
    logger.info(`Analyzing ${asset}...`);

    // Sequential with delay to avoid CryptoCompare rate limit
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

    // Signal
    let signal: Signal = 'HOLD';
    const allBullish = tf4h.uptrend && tf1h.uptrend;
    const allBearish = !tf4h.uptrend && !tf1h.uptrend;
    const longEntry  = tf15m.bullishCross && tf15m.rsi>=config.ta.rsiBuyMin && tf15m.rsi<=config.ta.rsiBuyMax;
    const shortEntry = tf15m.bearishCross && tf15m.rsi>=35 && tf15m.rsi<=60;

    if      (allBullish && longEntry)            signal = 'LONG';
    else if (allBearish && shortEntry)           signal = 'SHORT';
    else if (tf15m.rsi >= config.ta.rsiSellMin) signal = 'SHORT';
    else if (tf15m.rsi <= 30 && tf4h.uptrend)   signal = 'LONG';

    if (signal === 'HOLD') {
      logger.info(`${asset} → HOLD | RSI:${tf15m.rsi.toFixed(1)} | ${trend4h}/${trend1h}`);
      return {
        asset, signal:'HOLD', reason:'No clear signal', confidence:0,
        currentPrice:price, rsi15m:tf15m.rsi, trend4h, trend1h,
        suggestedSL:0, suggestedTP:0, slPct:0, tpPct:0, rrRatio:0,
      };
    }

    const conf = calcConfidence(tf15m, tf1h, tf4h, signal);

    // Dynamic SL/TP
    let sl: number, tp: number;
    if (signal === 'LONG') {
      sl = swingLow(c15m, config.ta.swingLookback) * 0.995;
      tp = Math.max(price + (price-sl)*config.ta.minRR, swingHigh(c1h)*0.99);
    } else {
      sl = swingHigh(c15m, config.ta.swingLookback) * 1.005;
      tp = Math.min(price - (sl-price)*config.ta.minRR, swingLow(c1h)*1.01);
    }

    const slDist = signal==='LONG' ? price-sl : sl-price;
    const tpDist = signal==='LONG' ? tp-price : price-tp;
    const rr     = tpDist / slDist;
    const slPct  = (slDist/price)*100;
    const tpPct  = (tpDist/price)*100;
    const reason = `${trend4h}/${trend1h} | RSI ${tf15m.rsi.toFixed(1)} | R:R ${rr.toFixed(1)}x | ${conf}% conf`;

    logger.info(`${asset} → ${signal} | conf:${conf}% | RSI:${tf15m.rsi.toFixed(1)} | ${trend4h}/${trend1h} | R:R:${rr.toFixed(2)}`);

    return {
      asset, signal, reason, confidence:conf, currentPrice:price,
      rsi15m:tf15m.rsi, trend4h, trend1h,
      suggestedSL:sl, suggestedTP:tp, slPct, tpPct, rrRatio:rr,
    };

  } catch (err: any) {
    logger.error(`${asset} analysis failed | ${err.message}`, { status: err.response?.status, data: err.response?.data });
    return null;
  }
}

export async function analyzeAll(): Promise<TAResult[]> {
  const results: TAResult[] = [];
  for (const asset of ASSETS) {
    const r = await analyzeAsset(asset).catch(() => null);
    if (r) results.push(r);
    await new Promise(res => setTimeout(res, 3000)); // 3s delay between assets
  }
  return results;
}
