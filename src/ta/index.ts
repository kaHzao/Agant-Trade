import { EMA, RSI, ATR, ADX } from 'technicalindicators';
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

// ─── Binance symbol map ───────────────────────────────────────────────────────

const BINANCE_SYMBOL: Record<string, string> = {
  SOL:  'SOLUSDT',
  BTC:  'BTCUSDT',
  WBTC: 'BTCUSDT',
  ETH:  'ETHUSDT',
};

// ─── Fetch OHLCV dari Binance (ganti CryptoCompare) ──────────────────────────

async function fetchOHLCV(asset: Asset, tf: '30m' | '1h' | '4h', limit = 100): Promise<Candle[]> {
  const symbol = BINANCE_SYMBOL[asset];
  if (!symbol) throw new Error(`Unknown asset: ${asset}`);

  // Binance pakai interval string langsung: 30m, 1h, 4h
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit + 1}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);

  const raw: any[][] = await res.json();

  // Buang candle terakhir — masih live/belum close
  const closed = raw.slice(0, -1);

  return closed.map((k) => ({
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
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
    high:  candles.map(c => c.high),
    low:   candles.map(c => c.low),
    close: candles.map(c => c.close),
  });
  return adxArr.length ? (adxArr[adxArr.length - 1].adx || 10) : 10;
}

// ─── ATR SL/TP ────────────────────────────────────────────────────────────────

function calcATRSlTp(candles: Candle[], price: number, signal: Signal) {
  const atrArr = ATR.calculate({
    period: 14,
    high:  candles.map(c => c.high),
    low:   candles.map(c => c.low),
    close: candles.map(c => c.close),
  });
  const atr = atrArr.length ? atrArr[atrArr.length - 1] : price * 0.02;

  if (signal === 'LONG') {
    return { sl: price - atr * 1.5, tp: price + atr * 1.5 * config.ta.minRR };
  } else {
    return { sl: price + atr * 1.5, tp: price - atr * 1.5 * config.ta.minRR };
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
    if (tf4hUp)  score += 25;
    if (tf1hUp)  score += 25;
    if (tf30mUp) score += 15;
    if (rsi >= 45 && rsi <= 58) score += 20;
    else if (rsi >= 40 && rsi <= 62) score += 10;
    if (adx > 25) score += 10;
    else if (adx > 20) score += 5;
    if (volOk) score += 5;
  } else {
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

    // Fetch 3 timeframes — delay 500ms antar request (Binance lebih cepat dari CC)
    const c30m = await fetchOHLCV(asset, '30m', 100);
    await new Promise(r => setTimeout(r, 500));
    const c1h  = await fetchOHLCV(asset, '1h',  100);
    await new Promise(r => setTimeout(r, 500));
    const c4h  = await fetchOHLCV(asset, '4h',  100);

    if (c30m.length < 60 || c1h.length < 60 || c4h.length < 25) {
      logger.warn(`${asset}: insufficient candles`);
      return null;
    }

    const price = c30m[c30m.length - 1].close;

    // Trend direction per TF
    const tf4hUp  = emaUptrend(c4h);
    const tf1hUp  = emaUptrend(c1h);
    const tf30mUp = emaUptrend(c30m);

    const trend4h = tf4hUp ? 'BULLISH' : 'BEARISH' as const;
    const trend1h = tf1hUp ? 'BULLISH' : 'BEARISH' as const;

    const adx    = getADX(c1h);
    const regime: MarketRegime = adx > 20 ? 'TRENDING' : 'SIDEWAYS';
    const rsi    = getRSI(c30m);
    const volOk  = volumeOk(c30m);

    // CORE LOGIC — STRICT ALIGNMENT RULE
    // 4h + 1h MUST agree → konflik = HOLD PAKSA
    let signal: Signal = 'HOLD';
    let reason = '';

    const conflict = tf4hUp !== tf1hUp;

    if (conflict) {
      reason = `KONFLIK: 4h ${trend4h} vs 1h ${trend1h} → HOLD PAKSA`;

    } else if (tf4hUp && tf1hUp) {
      if (rsi >= 40 && rsi <= 60) {
        signal = 'LONG';
        reason = `4h✓ 1h✓ 30m:${tf30mUp ? '✓' : '↕'} | RSI:${rsi.toFixed(1)}`;
      } else if (rsi > 60) {
        reason = `4h+1h BULLISH tapi RSI terlalu tinggi (${rsi.toFixed(1)}) → tunggu pullback`;
      } else {
        reason = `4h+1h BULLISH tapi RSI terlalu rendah (${rsi.toFixed(1)})`;
      }

    } else if (!tf4hUp && !tf1hUp) {
      if (rsi >= 40 && rsi <= 60) {
        signal = 'SHORT';
        reason = `4h✓ 1h✓ 30m:${!tf30mUp ? '✓' : '↕'} | RSI:${rsi.toFixed(1)}`;
      } else if (rsi < 40) {
        reason = `4h+1h BEARISH tapi RSI terlalu rendah (${rsi.toFixed(1)}) → tunggu bounce`;
      } else {
        reason = `4h+1h BEARISH tapi RSI terlalu tinggi (${rsi.toFixed(1)})`;
      }
    }

    const confidence = signal !== 'HOLD'
      ? calcConfidence(signal, tf4hUp, tf1hUp, tf30mUp, rsi, adx, volOk)
      : 0;

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

    const { sl, tp } = calcATRSlTp(c30m, price, signal);
    const slDist = signal === 'LONG' ? price - sl : sl - price;
    const tpDist = signal === 'LONG' ? tp - price : price - tp;
    const rr     = tpDist / slDist;
    const slPct  = (slDist / price) * 100;
    const tpPct  = (tpDist / price) * 100;

    if (rr < config.ta.minRR) {
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
