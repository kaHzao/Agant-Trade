import { EMA, RSI, ATR, ADX, MACD, BollingerBands } from 'technicalindicators';
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
  rsi: number;               // RSI dari 30m (entry timing)
  trend4h: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  trend1h: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  regime: MarketRegime;
  adx: number;
  adxRising: boolean;        // ADX naik = trend menguat
  suggestedSL: number;
  suggestedTP: number;
  slPct: number;
  tpPct: number;
  rrRatio: number;
  macdHistogram: number;     // MACD histogram 1H (momentum)
  bbPosition: number;        // 0=lower band, 1=upper band (1H)
  bbSqueeze: boolean;        // BB bandwidth <3% = volatility compression
  emaSlope1h: number;        // EMA20 slope % per 5 candles (1H, trend quality)
}

interface Candle {
  open: number; high: number; low: number;
  close: number; volume: number;
}

interface MacdData {
  histogram: number;
  histGrowing: boolean;  // momentum sedang membangun
  aboveZero: boolean;    // MACD line di atas nol
  bullish: boolean;      // histogram positif
}

interface BBData {
  position: number;      // 0=lower band, 1=upper band
  bandwidth: number;     // % dari harga
  squeeze: boolean;      // bandwidth < 3%
  aboveUpper: boolean;   // harga di atas upper band
  belowLower: boolean;   // harga di bawah lower band
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

// ─── EMA Slope — % change per lookback candles ────────────────────────────────
// Dipakai untuk filter trend health: EMA flat/negatif = trend palsu/exhausted

function getEmaSlope(candles: Candle[], period = 20, lookback = 5): number {
  const closes = candles.map(c => c.close);
  const emas = EMA.calculate({ period, values: closes });
  if (emas.length < lookback + 1) return 0;
  const current = emas[emas.length - 1];
  const past    = emas[emas.length - 1 - lookback];
  return ((current - past) / past) * 100;
}

// ─── RSI ──────────────────────────────────────────────────────────────────────

function getRSI(candles: Candle[]): number {
  const rsiArr = RSI.calculate({ period: 14, values: candles.map(c => c.close) });
  return rsiArr.length ? rsiArr[rsiArr.length - 1] : 50;
}

// ─── ADX + slope — dari 1h ────────────────────────────────────────────────────

function getADX(candles: Candle[]): { adx: number; rising: boolean } {
  const adxArr = ADX.calculate({
    period: 14,
    high:   candles.map(c => c.high),
    low:    candles.map(c => c.low),
    close:  candles.map(c => c.close),
  });
  if (!adxArr.length) return { adx: 10, rising: false };

  const adx = adxArr[adxArr.length - 1].adx ?? 10;
  // Bandingkan dengan 4 candle lalu untuk detect trend strengthening
  const rising = adxArr.length >= 5
    ? adx > (adxArr[adxArr.length - 5].adx ?? adx)
    : false;

  return { adx, rising };
}

// ─── MACD — momentum confirmation (1H) ───────────────────────────────────────
// Konfirmasi bahwa momentum harga sejalan dengan sinyal.
// MACD histogram positif & growing = buying pressure nyata.
// Mencegah entry saat harga naik tapi momentum sudah melemah.

function getMacd(candles: Candle[]): MacdData {
  const closes  = candles.map(c => c.close);
  const results = MACD.calculate({
    values:              closes,
    fastPeriod:          12,
    slowPeriod:          26,
    signalPeriod:        9,
    SimpleMAOscillator:  false,
    SimpleMASignal:      false,
  });

  if (results.length < 3) {
    return { histogram: 0, histGrowing: false, aboveZero: false, bullish: false };
  }

  const last          = results[results.length - 1];
  const prev          = results[results.length - 2];
  const histogram     = last.histogram ?? 0;
  const prevHistogram = prev.histogram ?? 0;
  const macdLine      = last.MACD ?? 0;

  // histGrowing: momentum sedang membangun ke arah sinyal
  // Bullish: histogram makin besar (lebih positif)
  // Bearish: histogram makin kecil (lebih negatif)
  const histGrowing = histogram > 0
    ? histogram > prevHistogram
    : histogram < prevHistogram;

  return {
    histogram,
    histGrowing,
    aboveZero: macdLine > 0,
    bullish:   histogram > 0,
  };
}

// ─── Bollinger Bands — volatility context (1H) ───────────────────────────────
// Memberikan context posisi harga relatif terhadap volatilitas.
// Entry dekat lower band (LONG) atau upper band (SHORT) = harga lebih "murah/mahal".
// BB squeeze = volatilitas rendah menjelang breakout besar.

function getBB(candles: Candle[]): BBData {
  const closes  = candles.map(c => c.close);
  const results = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });

  if (!results.length) {
    return { position: 0.5, bandwidth: 5, squeeze: false, aboveUpper: false, belowLower: false };
  }

  const { upper, lower, middle } = results[results.length - 1];
  const price     = closes[closes.length - 1];
  const bandWidth = upper - lower;
  const position  = bandWidth > 0 ? (price - lower) / bandWidth : 0.5;
  const bandwidth = (bandWidth / middle) * 100; // % dari harga

  return {
    position,
    bandwidth,
    squeeze:    bandwidth < 3.0,   // volatilitas sangat rendah
    aboveUpper: price > upper,
    belowLower: price < lower,
  };
}

// ─── ATR SL/TP — dynamic multiplier berdasarkan volatilitas ──────────────────
// SL lebih ketat di market high-vol (hindari SL terlalu lebar),
// lebih lebar di market low-vol (hindari whipsaw).

function calcATRSlTp(candles1h: Candle[], price: number, signal: Signal) {
  const atrArr = ATR.calculate({
    period: 14,
    high:   candles1h.map(c => c.high),
    low:    candles1h.map(c => c.low),
    close:  candles1h.map(c => c.close),
  });
  const atr    = atrArr.length ? atrArr[atrArr.length - 1] : price * 0.02;
  const atrPct = (atr / price) * 100;

  // Dynamic multiplier berdasarkan ATR% dari harga
  let multiplier: number;
  if      (atrPct > 2.5) multiplier = 2.0;  // very high vol → SL lebih ketat
  else if (atrPct > 1.5) multiplier = 2.5;  // normal-high → standard
  else if (atrPct > 0.8) multiplier = 3.0;  // normal-low → sedikit lebih lebar
  else                   multiplier = 3.5;  // very low vol → SL lebih lebar (hindari noise)

  const slDist = atr * multiplier;
  const tpDist = slDist * config.ta.minRR;

  if (signal === 'LONG') {
    return { sl: price - slDist, tp: price + tpDist, atr, atrPct, multiplier };
  } else {
    return { sl: price + slDist, tp: price - tpDist, atr, atrPct, multiplier };
  }
}

// ─── Volume OK ────────────────────────────────────────────────────────────────

function volumeOk(candles: Candle[]): boolean {
  const avgVol = candles.slice(-11, -1).reduce((s, c) => s + c.volume, 0) / 10;
  return candles[candles.length - 1].volume >= avgVol * config.ta.volumeMultiplier;
}

// ─── Confidence Score ─────────────────────────────────────────────────────────
// Sistem scoring multi-faktor. Lebih banyak faktor yang align = confidence lebih tinggi.
// Harus >= config.ta.minConfidence (65%) untuk execute trade.
//
// Faktor baru vs versi lama:
//   + MACD histogram direction & strength (+18 max)
//   + Bollinger Bands position & squeeze (+13 max)
//   + EMA slope 1H — trend health (+5 max, -5 penalty)
//   + ADX slope — trend strengthening (+5)
//   ± RSI zones diperlebar (40-72 LONG, 28-62 SHORT)
//   ↑ ADX bonus lebih granular (>35 bonus lebih besar)

function calcConfidence(
  signal: Signal,
  tf4hUp: boolean,
  tf1hUp: boolean,
  tf30mUp: boolean,
  rsi: number,
  adx: number,
  adxRising: boolean,
  volOk: boolean,
  macd: MacdData,
  bb: BBData,
  emaSlope1h: number
): number {
  let score = 0;

  if (signal === 'LONG') {
    // Core trend alignment (max 50)
    if (tf4hUp)  score += 20;
    if (tf1hUp)  score += 20;
    if (tf30mUp) score += 10;

    // RSI zones — diperlebar vs versi lama (45-58)
    // 48-65 = ideal pullback zone dalam uptrend
    // 40-72 = acceptable (masih reasonable beli)
    if      (rsi >= 48 && rsi <= 65) score += 15;
    else if (rsi >= 40 && rsi <= 72) score += 8;

    // ADX strength — lebih granular
    if      (adx > 35) score += 12;
    else if (adx > 28) score += 8;
    else if (adx > 23) score += 4;
    if (adxRising)     score += 5;  // trend sedang menguat

    // MACD momentum confirmation (1H) — NEW
    if (macd.bullish)                      score += 10; // histogram positif
    if (macd.bullish && macd.histGrowing)  score += 5;  // momentum building
    if (macd.aboveZero)                    score += 3;  // MACD line di atas nol

    // Bollinger Bands position (1H) — NEW
    // Entry dekat lower band = beli di "diskon", lebih aman
    if      (bb.position < 0.35) score += 8;  // dekat lower band
    else if (bb.position < 0.50) score += 4;  // di bawah midline
    if (bb.squeeze)               score += 5;  // volatility compression
    if (bb.aboveUpper)            score -= 8;  // overbought extension, harga extended

    // EMA slope — trend health (1H) — NEW
    // Slope sangat kecil/negatif = EMA cross palsu atau trend sudah habis
    if      (emaSlope1h > 0.15) score += 5;   // slope curam ke atas
    else if (emaSlope1h > 0.05) score += 2;   // slope moderat
    else if (emaSlope1h < 0)    score -= 5;   // slope negatif = warning

    // Volume spike
    if (volOk) score += 5;

  } else { // SHORT
    // Core trend alignment (max 50)
    if (!tf4hUp)  score += 20;
    if (!tf1hUp)  score += 20;
    if (!tf30mUp) score += 10;

    // RSI zones untuk SHORT — diperlebar dari (42-55)
    // 35-52 = ideal (momentum sudah balik tapi belum oversold)
    // 28-62 = acceptable
    if      (rsi >= 35 && rsi <= 52) score += 15;
    else if (rsi >= 28 && rsi <= 62) score += 8;

    if      (adx > 35) score += 12;
    else if (adx > 28) score += 8;
    else if (adx > 23) score += 4;
    if (adxRising)     score += 5;

    // MACD — bearish momentum — NEW
    if (!macd.bullish)                      score += 10; // histogram negatif
    if (!macd.bullish && macd.histGrowing)  score += 5;  // bearish momentum building
    if (!macd.aboveZero)                    score += 3;  // MACD line di bawah nol

    // BB untuk SHORT — NEW
    // Entry dekat upper band = short di area "mahal"
    if      (bb.position > 0.65) score += 8;  // dekat upper band
    else if (bb.position > 0.50) score += 4;  // di atas midline
    if (bb.squeeze)               score += 5;
    if (bb.belowLower)            score -= 8;  // oversold extension, terlalu jauh

    // EMA slope — down health (1H) — NEW
    if      (emaSlope1h < -0.15) score += 5;  // slope curam ke bawah
    else if (emaSlope1h < -0.05) score += 2;  // slope moderat turun
    else if (emaSlope1h > 0)     score -= 5;  // slope positif = EMA cross mungkin palsu

    if (volOk) score += 5;
  }

  return Math.max(0, Math.min(100, score));
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

    // ── Trend per timeframe ───────────────────────────────────────────────────
    const tf4hUp  = emaUptrend(c4h);
    const tf1hUp  = emaUptrend(c1h);
    const tf30mUp = emaUptrend(c30m);

    const trend4h = tf4hUp ? 'BULLISH' : 'BEARISH' as const;
    const trend1h = tf1hUp ? 'BULLISH' : 'BEARISH' as const;

    // ── ADX + slope dari 1h ───────────────────────────────────────────────────
    const { adx, rising: adxRising } = getADX(c1h);
    const regime: MarketRegime = adx > 23 ? 'TRENDING' : 'SIDEWAYS';

    // ── RSI dari 30m (entry timing) ───────────────────────────────────────────
    const rsi   = getRSI(c30m);
    const volOk = volumeOk(c30m);

    // ── Indikator baru — semua dari 1H untuk konsistensi ─────────────────────
    const macd       = getMacd(c1h);
    const bb         = getBB(c1h);
    const emaSlope1h = getEmaSlope(c1h);

    let signal: Signal = 'HOLD';
    let reason = '';

    // ── Hard filter 1: ADX terlalu lemah → block entry ────────────────────────
    if (adx < 28) {
      reason = `ADX terlalu lemah (${adx.toFixed(1)} < 28) → HOLD, tunggu trending`;
      logger.info(`${asset} → HOLD | ADX:${adx.toFixed(1)} < 28`);
      return {
        asset, signal: 'HOLD', reason,
        confidence: 0, currentPrice: price, rsi,
        trend4h, trend1h, regime, adx, adxRising,
        suggestedSL: 0, suggestedTP: 0, slPct: 0, tpPct: 0, rrRatio: 0,
        macdHistogram: macd.histogram, bbPosition: bb.position,
        bbSqueeze: bb.squeeze, emaSlope1h,
      };
    }

    // ── Hard filter 2: 4H vs 1H konflik ──────────────────────────────────────
    const conflict = tf4hUp !== tf1hUp;

    if (conflict) {
      reason = `KONFLIK: 4h ${trend4h} vs 1h ${trend1h} → HOLD PAKSA`;

    } else if (tf4hUp && tf1hUp) {
      // Hard filter 3: RSI extreme overbought → jangan kejar harga
      if (rsi > 75) {
        reason = `4h+1h BULLISH tapi RSI OVERBOUGHT (${rsi.toFixed(1)} > 75) → tunggu koreksi`;
      } else if (rsi >= 40 && rsi <= 72) {
        signal = 'LONG';
        reason = (
          `4h✓ 1h✓ 30m:${tf30mUp ? '✓' : '↕'} | RSI:${rsi.toFixed(1)} | ADX:${adx.toFixed(1)} | ` +
          `MACD:${macd.bullish ? '↑' : '↓'}${macd.histogram.toFixed(4)} | BB:${(bb.position * 100).toFixed(0)}%`
        );
      } else if (rsi > 72) {
        reason = `4h+1h BULLISH tapi RSI terlalu tinggi (${rsi.toFixed(1)} > 72)`;
      } else {
        reason = `4h+1h BULLISH tapi RSI terlalu rendah (${rsi.toFixed(1)} < 40)`;
      }

    } else if (!tf4hUp && !tf1hUp) {
      // Hard filter 3: RSI extreme oversold → jangan short di bottom
      if (rsi < 25) {
        reason = `4h+1h BEARISH tapi RSI OVERSOLD (${rsi.toFixed(1)} < 25) → tunggu bounce`;
      } else if (rsi >= 28 && rsi <= 62) {
        signal = 'SHORT';
        reason = (
          `4h✓ 1h✓ 30m:${!tf30mUp ? '✓' : '↕'} | RSI:${rsi.toFixed(1)} | ADX:${adx.toFixed(1)} | ` +
          `MACD:${!macd.bullish ? '↓' : '↑'}${macd.histogram.toFixed(4)} | BB:${(bb.position * 100).toFixed(0)}%`
        );
      } else if (rsi < 28) {
        reason = `4h+1h BEARISH tapi RSI oversold (${rsi.toFixed(1)} < 28)`;
      } else {
        reason = `4h+1h BEARISH tapi RSI terlalu tinggi (${rsi.toFixed(1)} > 62)`;
      }
    }

    const confidence = signal !== 'HOLD'
      ? calcConfidence(signal, tf4hUp, tf1hUp, tf30mUp, rsi, adx, adxRising, volOk, macd, bb, emaSlope1h)
      : 0;

    if (signal !== 'HOLD' && confidence < config.ta.minConfidence) {
      reason = `${signal} blocked — confidence too low (${confidence}% < ${config.ta.minConfidence}%)`;
      signal = 'HOLD';
    }

    logger.info(
      `${asset} → ${signal} | ${regime} | ADX:${adx.toFixed(1)}${adxRising ? '↑' : '↓'} | conf:${confidence}% | ` +
      `RSI:${rsi.toFixed(1)} | 4h:${trend4h} | 1h:${trend1h} | 30m:${tf30mUp ? 'UP' : 'DOWN'} | ` +
      `MACD:${macd.histogram.toFixed(4)} | BB:${(bb.position * 100).toFixed(0)}% | slope:${emaSlope1h.toFixed(3)}%`
    );

    if (signal === 'HOLD') {
      return {
        asset, signal: 'HOLD', reason,
        confidence, currentPrice: price, rsi,
        trend4h, trend1h, regime, adx, adxRising,
        suggestedSL: 0, suggestedTP: 0, slPct: 0, tpPct: 0, rrRatio: 0,
        macdHistogram: macd.histogram, bbPosition: bb.position,
        bbSqueeze: bb.squeeze, emaSlope1h,
      };
    }

    // ── SL/TP dari ATR 1h dengan dynamic multiplier ───────────────────────────
    const { sl, tp, atr, atrPct, multiplier } = calcATRSlTp(c1h, price, signal);
    const slDist = signal === 'LONG' ? price - sl : sl - price;
    const tpDist = signal === 'LONG' ? tp - price : price - tp;
    const rr     = tpDist / slDist;
    const slPct  = (slDist / price) * 100;
    const tpPct  = (tpDist / price) * 100;

    logger.info(
      `${asset} ATR(1h):${atr.toFixed(3)} (${atrPct.toFixed(2)}%) mult:×${multiplier} ` +
      `SL:${sl.toFixed(2)} TP:${tp.toFixed(2)} RR:${rr.toFixed(2)}`
    );

    if (rr < config.ta.minRR - 0.001) { // -0.001 tolerance untuk floating point precision
      logger.info(`${asset}: R:R too low (${rr.toFixed(2)} < ${config.ta.minRR}) → HOLD`);
      return {
        asset, signal: 'HOLD',
        reason: `R:R too low (${rr.toFixed(2)})`,
        confidence, currentPrice: price, rsi,
        trend4h, trend1h, regime, adx, adxRising,
        suggestedSL: 0, suggestedTP: 0, slPct: 0, tpPct: 0, rrRatio: rr,
        macdHistogram: macd.histogram, bbPosition: bb.position,
        bbSqueeze: bb.squeeze, emaSlope1h,
      };
    }

    return {
      asset, signal, reason, confidence, currentPrice: price, rsi,
      trend4h, trend1h, regime, adx, adxRising,
      suggestedSL: sl, suggestedTP: tp, slPct, tpPct, rrRatio: rr,
      macdHistogram: macd.histogram, bbPosition: bb.position,
      bbSqueeze: bb.squeeze, emaSlope1h,
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
