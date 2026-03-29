import axios from 'axios';
import { EMA, RSI } from 'technicalindicators';
import { config, type Asset, ASSETS } from '../utils/config';
import { logger } from '../utils/logger';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';

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

// ─── Get jup binary path ──────────────────────────────────────────────────────

function getJupPath(): string {
  try { execSync('jup --version', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }); return 'jup'; } catch {}
  const win = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'jup.cmd');
  try { execSync(`"${win}" --version`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }); return `"${win}"`; } catch {}
  return 'jup';
}
const JUP = getJupPath();

// ─── Fetch OHLCV via jup perps markets (price) + synthetic candles ───────────
// Since most APIs block GitHub Actions IPs, we use jup CLI which already works
// and supplement with public price endpoints that GitHub allows

const ASSET_IDS: Record<Asset, string> = {
  SOL: 'solana',
  BTC: 'bitcoin', 
  ETH: 'ethereum',
};

// Fetch price history from CryptoCompare (no geo-block, no key needed)
async function fetchOHLCV(asset: Asset, tf: '15m' | '1h' | '4h', limit = 60): Promise<Candle[]> {
  const AGGREGATE: Record<string, { endpoint: string; aggregate: number }> = {
    '15m': { endpoint: 'histominute', aggregate: 15 },
    '1h':  { endpoint: 'histohour',   aggregate: 1  },
    '4h':  { endpoint: 'histohour',   aggregate: 4  },
  };

  const { endpoint, aggregate } = AGGREGATE[tf];
  const symbol = asset; // SOL, BTC, ETH

  const { data } = await axios.get(
    `https://min-api.cryptocompare.com/data/${endpoint}`,
    {
      params: { fsym: symbol, tsym: 'USD', limit, aggregate },
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
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
  const higherHighs = candles.length >= lb*2 ? Math.max(...rH)>Math.max(...pH) && Math.min(...rL)>Math.min(...pL) : false;
  const lowerLows   = candles.length >= lb*2 ? Math.max(...rH)<Math.max(...pH) && Math.min(...rL)<Math.min(...pL) : false;

  return {
    emaFast:ef, emaSlow:es, emaFastPrev:efp, emaSlowPrev:esp,
    rsi: ra[ra.length-1], currentPrice: closes[closes.length-1],
    uptrend: ef>es,
    bullishCross: efp<=esp && ef>es,
    bearishCross: efp>=esp && ef<es,
    volumeOk, higherHighs, lowerLows,
  };
}

function calcConfidence(tf15m: TFResult, tf1h: TFResult, tf4h: TFResult, signal: Signal): number {
  let s = 0;
  if (signal === 'LONG') {
    if (tf4h.uptrend)  s+=20; if (tf1h.uptrend)  s+=15; if (tf15m.uptrend) s+=10;
    if (tf15m.rsi>=45&&tf15m.rsi<=60) s+=20; else if (tf15m.rsi>=40&&tf15m.rsi<=65) s+=10;
    if (tf15m.volumeOk) s+=10; if (tf1h.higherHighs) s+=10; if (tf4h.higherHighs) s+=5;
    if (tf15m.bullishCross) s+=10;
  } else {
    if (!tf4h.uptrend) s+=20; if (!tf1h.uptrend) s+=15; if (!tf15m.uptrend) s+=10;
    if (tf15m.rsi>=40&&tf15m.rsi<=55) s+=20; else if (tf15m.rsi>=35&&tf15m.rsi<=60) s+=10;
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

    const [c15m, c1h, c4h] = await Promise.all([
      fetchOHLCV(asset, '15m', 60),
      fetchOHLCV(asset, '1h',  60),
      fetchOHLCV(asset, '4h',  60),
    ]);

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

    if      (allBullish && longEntry)               signal = 'LONG';
    else if (allBearish && shortEntry)              signal = 'SHORT';
    else if (tf15m.rsi >= config.ta.rsiSellMin)    signal = 'SHORT';
    else if (tf15m.rsi <= 30 && tf4h.uptrend)      signal = 'LONG';

    if (signal === 'HOLD') {
      logger.info(`${asset} → HOLD | RSI:${tf15m.rsi.toFixed(1)} | ${trend4h}/${trend1h}`);
      return { asset, signal:'HOLD', reason:'No clear signal', confidence:0,
        currentPrice:price, rsi15m:tf15m.rsi, trend4h, trend1h,
        suggestedSL:0, suggestedTP:0, slPct:0, tpPct:0, rrRatio:0 };
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
    const rr    = tpDist/slDist;
    const slPct = (slDist/price)*100;
    const tpPct = (tpDist/price)*100;
    const reason = `${trend4h}/${trend1h} | RSI ${tf15m.rsi.toFixed(1)} | R:R ${rr.toFixed(1)}x | ${conf}% conf`;

    logger.info(`${asset} → ${signal} | conf:${conf}% | RSI:${tf15m.rsi.toFixed(1)} | ${trend4h}/${trend1h} | R:R:${rr.toFixed(2)}`);

    return { asset, signal, reason, confidence:conf, currentPrice:price,
      rsi15m:tf15m.rsi, trend4h, trend1h,
      suggestedSL:sl, suggestedTP:tp, slPct, tpPct, rrRatio:rr };

  } catch (err) {
    logger.error(`${asset} analysis failed`, err);
    return null;
  }
}

export async function analyzeAll(): Promise<TAResult[]> {
  const results = await Promise.allSettled(ASSETS.map(analyzeAsset));
  return results.map(r => r.status==='fulfilled' ? r.value : null).filter((r): r is TAResult => r!==null);
}
