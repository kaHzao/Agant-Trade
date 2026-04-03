import axios from 'axios';
import { EMA, RSI, ATR, ADX } from 'technicalindicators';
import { config, type Asset, ASSETS } from '../utils/config';
import { logger } from '../utils/logger';

export type Signal      = 'LONG' | 'SHORT' | 'HOLD';
export type MarketRegime = 'TRENDING' | 'SIDEWAYS';

export interface TAResult {
  asset:        Asset;
  signal:       Signal;
  reason:       string;
  confidence:   number;
  currentPrice: number;
  rsi:          number;
  trend4h:      'BULLISH' | 'BEARISH' | 'NEUTRAL';
  trend1h:      'BULLISH' | 'BEARISH' | 'NEUTRAL';
  trend30m:     'BULLISH' | 'BEARISH' | 'NEUTRAL';
  regime:       MarketRegime;
  adx:          number;
  suggestedSL:  number;
  suggestedTP:  number;
  slPct:        number;
  tpPct:        number;
  rrRatio:      number;
}

interface Candle {
  open: number; high: number; low: number;
  close: number; volume: number;
}

// ─── Fetch OHLCV dari CryptoCompare ──────────────────────────────────────────

async function fetchOHLCV(asset: Asset, tf: '30m' | '1h' | '4h', limit = 100): Promise<Candle[]> {
  const endpoint  = tf === '30m' ? 'histominute' : 'histohour';
  const aggregate = tf === '30m' ? 30 : tf === '1h' ? 1 : 4;

  const { data } = await axios.get(
    `https://min-api.cryptocompare.com/data/${endpoint}`,
    {
      params:  { fsym: asset, tsym: 'USD', limit, aggregate },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15_000,
    }
  );

  if (data.Response === 'Error') throw new Error(data.Message);
  return (data.Data || []).map((k: any) => ({
    open: k.open, high: k.high, low: k.low,
    close: k.close, volume: k.volumeto,   // USD-denominated volume
  }));
}

// ─── EMA trend direction ──────────────────────────────────────────────────────
// FIX: baca dari config, bukan hardcode

function emaUptrend(candles: Candle[]): boolean {
  const closes = candles.map(c => c.close);
  const fast = EMA.calculate({ period: config.ta.emaFast, values: closes });
  const slow = EMA.calculate({ period: config.ta.emaSlow, values: closes });
  if (!fast.length || !slow.length) return false;
  // Trend dianggap kuat jika EMA fast > slow DAN slope fast positif (2 bar terakhir)
  const fastUp = fast[fast.length - 1] > fast[fast.length - 2];
  return fast[fast.length - 1] > slow[slow.length - 1] && fastUp;
}

// ─── RSI ──────────────────────────────────────────────────────────────────────

function getRSI(candles: Candle[]): number {
  const arr = RSI.calculate({ period: config.ta.rsiPeriod, values: candles.map(c => c.close) });
  return arr.length ? arr[arr.length - 1] : 50;
}

// ─── ADX ──────────────────────────────────────────────────────────────────────

function getADX(candles: Candle[]): number {
  const arr = ADX.calculate({
    period: 14,
    high:   candles.map(c => c.high),
    low:    candles.map(c => c.low),
    close:  candles.map(c => c.close),
  });
  return arr.length ? (arr[arr.length - 1].adx || 10) : 10;
}

// ─── ATR SL/TP — FIX: gunakan 1h candle, baca multiplier dari config ─────────

function calcATRSlTp(
  c1h: Candle[],
  price: number,
  signal: Signal
): { sl: number; tp: number } {
  const arr = ATR.calculate({
    period: config.ta.atrPeriod,
    high:   c1h.map(c => c.high),
    low:    c1h.map(c => c.low),
    close:  c1h.map(c => c.close),
  });

  const atr = arr.length ? arr[arr.length - 1] : price * 0.015;
  const slDist = atr * config.ta.atrMultiplier;   // FIX: baca dari config
  const tpDist = atr * config.ta.atrTpMultiplier; // FIX: TP independen dari SL

  if (signal === 'LONG') {
    return { sl: price - slDist, tp: price + tpDist };
  } else {
    return { sl: price + slDist, tp: price - tpDist };
  }
}

// ─── Volume filter ────────────────────────────────────────────────────────────

function volumeOk(candles: Candle[]): boolean {
  const recent = candles.slice(-11, -1);
  if (recent.length < 5) return true; // tidak cukup data = skip filter
  const avg = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  return candles[candles.length - 1].volume >= avg * config.ta.volumeMultiplier;
}

// ─── Confidence score ─────────────────────────────────────────────────────────
// Komponen score:
//   4h align    : 30 pts  (wajib ada)
//   1h align    : 25 pts  (wajib ada)
//   30m align   : 15 pts  (timing bonus)
//   RSI zone    : 15 pts
//   ADX strength: 10 pts
//   Volume      :  5 pts
//   Total max   : 100

function calcConfidence(
  signal:   Signal,
  tf4hUp:   boolean,
  tf1hUp:   boolean,
  tf30mUp:  boolean,
  rsi:      number,
  adx:      number,
  volOk:    boolean
): number {
  let score = 0;

  const isLong = signal === 'LONG';

  // TF alignment
  if (isLong ? tf4hUp  : !tf4hUp)  score += 30;
  if (isLong ? tf1hUp  : !tf1hUp)  score += 25;
  if (isLong ? tf30mUp : !tf30mUp) score += 15;

  // RSI zone — lebih lebar, beda threshold LONG vs SHORT
  if (isLong) {
    if (rsi >= config.ta.rsiBuyMin && rsi <= config.ta.rsiBuyMax) score += 15;
    else if (rsi >= 35 && rsi <= 70) score += 5; // partial
  } else {
    if (rsi >= config.ta.rsiShortMin && rsi <= config.ta.rsiShortMax) score += 15;
    else if (rsi >= 30 && rsi <= 65) score += 5;
  }

  // ADX strength
  if (adx >= config.ta.adxStrong)   score += 10;
  else if (adx >= config.ta.adxTrending) score += 5;

  // Volume
  if (volOk) score += 5;

  return Math.min(100, score);
}

// ─── Main analysis ────────────────────────────────────────────────────────────

export async function analyzeAsset(asset: Asset): Promise<TAResult | null> {
  try {
    logger.info(`Analyzing ${asset}...`);

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

    // ── Trend direction per TF ────────────────────────────────────────────────
    const tf4hUp  = emaUptrend(c4h);
    const tf1hUp  = emaUptrend(c1h);
    const tf30mUp = emaUptrend(c30m);

    const trend4h  = tf4hUp  ? 'BULLISH' : 'BEARISH' as const;
    const trend1h  = tf1hUp  ? 'BULLISH' : 'BEARISH' as const;
    const trend30m = tf30mUp ? 'BULLISH' : 'BEARISH' as const;

    // ── ADX dari 1h ──────────────────────────────────────────────────────────
    const adx    = getADX(c1h);
    const regime: MarketRegime = adx >= config.ta.adxTrending ? 'TRENDING' : 'SIDEWAYS';

    // ── RSI dari 30m ─────────────────────────────────────────────────────────
    const rsi = getRSI(c30m);

    // ── Volume dari 30m ──────────────────────────────────────────────────────
    const volOk = volumeOk(c30m);

    // ── SIDEWAYS filter: jangan entry kalau market tidak trending ─────────────
    if (regime === 'SIDEWAYS') {
      const reason = `SIDEWAYS market (ADX:${adx.toFixed(1)} < ${config.ta.adxTrending}) → HOLD`;
      logger.info(`${asset} → HOLD | ${reason}`);
      return makeHold(asset, reason, price, rsi, trend4h, trend1h, trend30m, regime, adx);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STRICT ALIGNMENT: 4h + 1h harus sepakat
    // 30m harus searah (timing gate, bukan hanya bonus)
    // ══════════════════════════════════════════════════════════════════════════

    let signal: Signal = 'HOLD';
    let reason = '';

    const tfConflict = tf4hUp !== tf1hUp;

    if (tfConflict) {
      reason = `KONFLIK 4h/1h: 4h ${trend4h} vs 1h ${trend1h} → HOLD`;

    } else if (tf4hUp && tf1hUp) {
      // Keduanya bullish
      if (!tf30mUp) {
        // 30m belum konfirmasi — tunggu alignment sempurna
        reason = `4h+1h BULLISH tapi 30m masih BEARISH → tunggu 30m konfirmasi`;
      } else if (rsi < config.ta.rsiBuyMin) {
        reason = `4h+1h+30m BULLISH tapi RSI terlalu rendah (${rsi.toFixed(1)}) → tunggu`;
      } else if (rsi > config.ta.rsiBuyMax) {
        reason = `4h+1h+30m BULLISH tapi RSI overbought (${rsi.toFixed(1)}) → tunggu pullback`;
      } else {
        signal = 'LONG';
        reason = `4h✅ 1h✅ 30m✅ | RSI:${rsi.toFixed(1)} | ADX:${adx.toFixed(0)}`;
      }

    } else if (!tf4hUp && !tf1hUp) {
      // Keduanya bearish
      if (tf30mUp) {
        reason = `4h+1h BEARISH tapi 30m masih BULLISH → tunggu 30m konfirmasi`;
      } else if (rsi > config.ta.rsiShortMax) {
        reason = `4h+1h+30m BEARISH tapi RSI terlalu tinggi (${rsi.toFixed(1)}) → tunggu`;
      } else if (rsi < config.ta.rsiShortMin) {
        reason = `4h+1h+30m BEARISH tapi RSI oversold (${rsi.toFixed(1)}) → tunggu bounce`;
      } else {
        signal = 'SHORT';
        reason = `4h✅ 1h✅ 30m✅ | RSI:${rsi.toFixed(1)} | ADX:${adx.toFixed(0)}`;
      }
    }

    // ── Confidence score ──────────────────────────────────────────────────────
    const confidence = signal !== 'HOLD'
      ? calcConfidence(signal, tf4hUp, tf1hUp, tf30mUp, rsi, adx, volOk)
      : 0;

    // ── Confidence gate ───────────────────────────────────────────────────────
    if (signal !== 'HOLD' && confidence < config.ta.minConfidence) {
      reason = `${signal} confidence terlalu rendah (${confidence}% < ${config.ta.minConfidence}%)`;
      signal = 'HOLD';
    }

    logger.info(
      `${asset} → ${signal} | ${regime} | ADX:${adx.toFixed(1)} | conf:${confidence}% | ` +
      `RSI:${rsi.toFixed(1)} | 4h:${trend4h} | 1h:${trend1h} | 30m:${trend30m}`
    );

    if (signal === 'HOLD') {
      return makeHold(asset, reason, price, rsi, trend4h, trend1h, trend30m, regime, adx, confidence);
    }

    // ── SL/TP: FIX — gunakan ATR dari 1h, multiplier dari config ─────────────
    const { sl, tp } = calcATRSlTp(c1h, price, signal);

    const slDist = signal === 'LONG' ? price - sl : sl - price;
    const tpDist = signal === 'LONG' ? tp - price : price - tp;

    // guard: SL/TP tidak boleh terbalik (ATR edge case)
    if (slDist <= 0 || tpDist <= 0) {
      logger.warn(`${asset}: invalid SL/TP geometry → HOLD`);
      return makeHold(asset, 'Invalid SL/TP geometry', price, rsi, trend4h, trend1h, trend30m, regime, adx);
    }

    const rr    = tpDist / slDist;
    const slPct = (slDist / price) * 100;
    const tpPct = (tpDist / price) * 100;

    // ── R:R gate — independen dari ATR calculation ────────────────────────────
    if (rr < config.ta.minRR) {
      logger.info(`${asset}: R:R terlalu rendah (${rr.toFixed(2)} < ${config.ta.minRR}) → HOLD`);
      return makeHold(asset, `R:R ${rr.toFixed(2)} < ${config.ta.minRR}`, price, rsi, trend4h, trend1h, trend30m, regime, adx, confidence);
    }

    return {
      asset, signal, reason, confidence, currentPrice: price,
      rsi, trend4h, trend1h, trend30m, regime, adx,
      suggestedSL: sl, suggestedTP: tp, slPct, tpPct, rrRatio: rr,
    };

  } catch (err: any) {
    logger.error(`${asset} analysis failed: ${err.message}`);
    return null;
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeHold(
  asset: Asset, reason: string, price: number, rsi: number,
  trend4h: 'BULLISH'|'BEARISH'|'NEUTRAL',
  trend1h: 'BULLISH'|'BEARISH'|'NEUTRAL',
  trend30m: 'BULLISH'|'BEARISH'|'NEUTRAL',
  regime: MarketRegime, adx: number, confidence = 0
): TAResult {
  return {
    asset, signal: 'HOLD', reason, confidence, currentPrice: price,
    rsi, trend4h, trend1h, trend30m, regime, adx,
    suggestedSL: 0, suggestedTP: 0, slPct: 0, tpPct: 0, rrRatio: 0,
  };
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
