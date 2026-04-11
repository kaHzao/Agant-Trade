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

// ─── OKX symbol map ───────────────────────────────────────────────────────────

const OKX_SYMBOL: Record<string, string> = {
  SOL:  'SOL-USDT',
  BTC:  'BTC-USDT',
  WBTC: 'BTC-USDT',
  ETH:  'ETH-USDT',
};

// ─── Fetch OHLCV dari OKX ─────────────────────────────────────────────────────

async function fetchOHLCV(asset: Asset, tf: '30m' | '1h' | '4h', limit = 100): Promise<Candle[]> {
  const instId = OKX_SYMBOL[asset];
  if (!instId) throw new Error(`Unknown asset: ${asset}`);

  const bar = tf === '30m' ? '30m' : tf === '1h' ? '1H' : '4H';
  const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit + 1}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`OKX API error: ${res.status}`);

  const json = await res.json();
  if (json.code !== '0') throw new Error(`OKX error: ${json.msg}`);

  // OKX: terbaru → terlama, reverse + buang candle live terakhir
  const candles = (json.data as string[][])
    .reverse()
    .slice(0, -1)
    .map(k => ({
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));

  return candles;
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

// ─── ADX dari 1h ──────────────────────────────────────────────────────────────

function getADX(candles: Candle[]): number {
  const adxArr = ADX.calculate({
    period: 14,
    high:  candles.map(c => c.high),
    low:   candles.map(c => c.low),
    close: candles.map(c => c.close),
  });
  return adxArr.length ? (adxArr[adxArr.length - 1].adx || 10) : 10;
}

// ─── ATR SL/TP — dari 1h (bukan 30m) ─────────────────────────────────────────

function calcATRSlTp(candles1h: Candle[], price: number, signal: Signal) {
  const atrArr = ATR.calculate({
    period: 14,
    high:  candles1h.map(c => c.high),
    low:   candles1h.map(c => c.low),
    close: candles1h.map(c => c.close),
  });
  const atr = atrArr.length ? atrArr[atrArr.length - 1] : price * 0.02;

  // SL: ATR 1h x2.5 — lebih lebar, hindari whipsaw
  // TP: SL x minRR (2.5) → RR 2.5
  const slDist = atr * 2.5;
  const tpDist = slDist * config.ta.minRR;

  if (signal === 'LONG') {
    return { sl: price - slDist, tp: price + tpDist, atr };
  } else {
    return { sl: price + slDist, tp: price - tpDist, atr };
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
    // RSI zone lebih sempit: 45-58 ideal, 40-62 acceptable
    if (rsi >= 45 && rsi <= 58) score += 20;
    else if (rsi >= 40 && rsi <= 62) score += 10;
    // ADX lebih ketat: >28 strong trend
    if (adx > 28) score += 10;
    else if (adx > 23) score += 5;
    if (volOk) score += 5;
  } else {
    if (!tf4hUp)  score += 25;
    if (!tf1hUp)  score += 25;
    if (!tf30mUp) score += 15;
    // RSI zone SHORT: 42-55 ideal
    if (rsi >= 42 && rsi <= 55) score += 20;
    else if (rsi >= 38 && rsi <= 60) score += 10;
    if (adx > 28) score += 10;
    else if (adx > 23) score += 5;
    if (volOk) score += 5;
  }

  return Math.min(100, score);
}

// ─── Main Analysis ────────────────────────────────────────────────────────────

export async function analyzeAsset(asset: Asset): Promise<TAResult | null> {
  try {
    logger.info(`Analyzing ${asset}...`);

    const c30m = await fetchOHLCV(asset, '30m', 100);
    await new Promise(r => setTimeout(r, 500));
    const c1h  = await fetchOHLCV(asset, '1h',  100);
    await new Promise(r => setTimeout(r, 500));
    const c4h  = await fetchOHLCV(asset, '4h',  100);

    if (c30m.length < 60 || c1h.length < 60 || c4h.length < 25) {
      logger.warn(`${asset}: insufficient candles`);
      return null;
    }

    const price = c1h[c1h.length - 1].close; // pakai 1h close sebagai price reference

    // Trend per TF
    const tf4hUp  = emaUptrend(c4h);
    const tf1hUp  = emaUptrend(c1h);
    const tf30mUp = emaUptrend(c30m);

    const trend4h = tf4hUp ? 'BULLISH' : 'BEARISH' as const;
    const trend1h = tf1hUp ? 'BULLISH' : 'BEARISH' as const;

    // ADX dari 1h — lebih stable dari 30m
    const adx    = getADX(c1h);
    const regime: MarketRegime = adx > 23 ? 'TRENDING' : 'SIDEWAYS';

    // RSI dari 30m — tetap untuk timing entry
    const rsi   = getRSI(c30m);
    const volOk = volumeOk(c30m);

    let signal: Signal = 'HOLD';
    let reason = '';

    // ADX filter ketat di depan — block entry kalau market sideways
    if (adx < 28) {
      reason = `ADX terlalu lemah (${adx.toFixed(1)} < 28) → HOLD, tunggu trending`;
      logger.info(`${asset} → HOLD | ADX:${adx.toFixed(1)} < 28`);
      return {
        asset, signal: 'HOLD', reason,
        confidence: 0, currentPrice: price, rsi15m: rsi,
        trend4h, trend1h, regime, adx,
        suggestedSL: 0, suggestedTP: 0, slPct: 0, tpPct: 0, rrRatio: 0,
      };
    }

    const conflict = tf4hUp !== tf1hUp;

    if (conflict) {
      reason = `KONFLIK: 4h ${trend4h} vs 1h ${trend1h} → HOLD PAKSA`;

    } else if (tf4hUp && tf1hUp) {
      // RSI zone LONG lebih sempit: 45-58
      if (rsi >= 45 && rsi <= 58) {
        signal = 'LONG';
        reason = `4h✓ 1h✓ 30m:${tf30mUp ? '✓' : '↕'} | RSI:${rsi.toFixed(1)} | ADX:${adx.toFixed(1)}`;
      } else if (rsi > 58) {
        reason = `4h+1h BULLISH tapi RSI overbought (${rsi.toFixed(1)}) → tunggu pullback`;
      } else {
        reason = `4h+1h BULLISH tapi RSI terlalu rendah (${rsi.toFixed(1)} < 45)`;
      }

    } else if (!tf4hUp && !tf1hUp) {
      // RSI zone SHORT: 42-55
      if (rsi >= 42 && rsi <= 55) {
        signal = 'SHORT';
        reason = `4h✓ 1h✓ 30m:${!tf30mUp ? '✓' : '↕'} | RSI:${rsi.toFixed(1)} | ADX:${adx.toFixed(1)}`;
      } else if (rsi < 42) {
        reason = `4h+1h BEARISH tapi RSI oversold (${rsi.toFixed(1)}) → tunggu bounce`;
      } else {
        reason = `4h+1h BEARISH tapi RSI terlalu tinggi (${rsi.toFixed(1)} > 55)`;
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

    // SL/TP dari ATR 1h
    const { sl, tp, atr } = calcATRSlTp(c1h, price, signal);
    const slDist = signal === 'LONG' ? price - sl : sl - price;
    const tpDist = signal === 'LONG' ? tp - price : price - tp;
    const rr     = tpDist / slDist;
    const slPct  = (slDist / price) * 100;
    const tpPct  = (tpDist / price) * 100;

    logger.info(`${asset} ATR(1h):${atr.toFixed(3)} SL:${sl.toFixed(2)} TP:${tp.toFixed(2)} RR:${rr.toFixed(2)}`);

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
