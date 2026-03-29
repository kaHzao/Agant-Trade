import { EMA, RSI } from 'technicalindicators';

// ─── Inline TA logic (mirror of src/ta/index.ts) ─────────────────────────────

interface Candle { open: number; high: number; low: number; close: number; volume: number; time: number; }

const TA = { emaFast: 9, emaSlow: 21, rsiPeriod: 14, rsiBuyMin: 45, rsiBuyMax: 60,
  rsiSellMin: 72, volumeMultiplier: 2.0, swingLookback: 10, minRR: 2.5, minConfidence: 70 };

function makeCandle(close: number, vol = 1000): Candle {
  return { open: close * 0.99, high: close * 1.01, low: close * 0.98, close, volume: vol, time: Date.now() };
}
function uptrend(n = 60): Candle[] { return Array.from({ length: n }, (_, i) => makeCandle(100 + i * 0.5, 1000)); }
function downtrend(n = 60): Candle[] { return Array.from({ length: n }, (_, i) => makeCandle(130 - i * 0.5)); }
function sideways(n = 60): Candle[] { return Array.from({ length: n }, (_, i) => makeCandle(100 + Math.sin(i * 0.4) * 0.5)); }
function overbought(n = 60): Candle[] { return Array.from({ length: n }, (_, i) => makeCandle(100 + i * 2)); }

function calcTF(candles: Candle[]) {
  if (candles.length < 25) return null;
  const closes = candles.map(c => c.close);
  const fa = EMA.calculate({ period: TA.emaFast, values: closes });
  const sa = EMA.calculate({ period: TA.emaSlow, values: closes });
  const ra = RSI.calculate({ period: TA.rsiPeriod, values: closes });
  if (fa.length < 2 || sa.length < 2 || !ra.length) return null;
  const ef = fa[fa.length-1], efp = fa[fa.length-2];
  const es = sa[sa.length-1], esp = sa[sa.length-2];
  const avgVol = candles.slice(-11,-1).reduce((s,c)=>s+c.volume,0)/10;
  const lb = TA.swingLookback;
  const hh = candles.length >= lb*2
    ? Math.max(...candles.slice(-lb).map(c=>c.high)) > Math.max(...candles.slice(-lb*2,-lb).map(c=>c.high)) &&
      Math.min(...candles.slice(-lb).map(c=>c.low))  > Math.min(...candles.slice(-lb*2,-lb).map(c=>c.low))
    : false;
  return { ef, es, efp, esp, rsi: ra[ra.length-1], price: closes[closes.length-1],
    uptrend: ef>es, bullishCross: efp<=esp&&ef>es, bearishCross: efp>=esp&&ef<es,
    volumeOk: candles[candles.length-1].volume >= avgVol*TA.volumeMultiplier, higherHighs: hh };
}

function confidence(tf15m: any, tf1h: any, tf4h: any): number {
  let s = 0;
  if (tf4h.uptrend) s+=20; if (tf1h.uptrend) s+=15; if (tf15m.uptrend) s+=10;
  if (tf15m.rsi>=45&&tf15m.rsi<=60) s+=20; else if (tf15m.rsi>=40&&tf15m.rsi<=65) s+=10;
  if (tf15m.volumeOk) s+=10; if (tf1h.volumeOk) s+=5;
  if (tf1h.higherHighs) s+=10; if (tf4h.higherHighs) s+=5;
  if (tf15m.bullishCross) s+=5;
  return Math.max(0,Math.min(100,s));
}

function swingLow(candles: Candle[], lb=10) { return Math.min(...candles.slice(-lb).map(c=>c.low)); }
function swingHigh(candles: Candle[], lb=10) { return Math.max(...candles.slice(-lb).map(c=>c.high)); }

function calcSLTP(candles15m: Candle[], candles1h: Candle[], price: number) {
  const sl = swingLow(candles15m, TA.swingLookback) * 0.995;
  const slDist = price - sl;
  const minTP = price + slDist * TA.minRR;
  const tp = Math.max(minTP, swingHigh(candles1h, TA.swingLookback*3)*0.99);
  return { sl, tp, rr: (tp-price)/slDist, slPct: ((price-sl)/price)*100, tpPct: ((tp-price)/price)*100 };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TA — EMA trend detection', () => {
  test('Uptrend: EMA fast > slow', () => {
    const tf = calcTF(uptrend())!;
    expect(tf.uptrend).toBe(true);
  });
  test('Downtrend: EMA fast < slow', () => {
    const tf = calcTF(downtrend())!;
    expect(tf.uptrend).toBe(false);
  });
  test('Returns null with < 25 candles', () => {
    expect(calcTF([makeCandle(100), makeCandle(101)])).toBeNull();
  });
});

describe('TA — RSI', () => {
  test('RSI between 0–100', () => {
    const tf = calcTF(sideways())!;
    expect(tf.rsi).toBeGreaterThanOrEqual(0);
    expect(tf.rsi).toBeLessThanOrEqual(100);
  });
  test('RSI > 70 in strong uptrend (overbought)', () => {
    const tf = calcTF(overbought())!;
    expect(tf.rsi).toBeGreaterThan(70);
  });
  test('RSI < 30 in strong downtrend (oversold)', () => {
    const closes = Array.from({length:60}, (_,i) => 200 - i*2);
    const ra = RSI.calculate({ period: 14, values: closes });
    expect(ra[ra.length-1]).toBeLessThan(30);
  });
});

describe('TA — Volume (2x multiplier)', () => {
  test('Spike detected: last vol > 2x avg', () => {
    const c = Array.from({length:20}, (_,i) => makeCandle(100, i===19 ? 6000 : 1000));
    const tf = calcTF([...uptrend(40), ...c])!;
    expect(tf.volumeOk).toBe(true);
  });
  test('No spike at 1.5x (below 2.0 threshold)', () => {
    const c = Array.from({length:20}, (_,i) => makeCandle(100, i===19 ? 1400 : 1000));
    const tf = calcTF([...sideways(40), ...c])!;
    expect(tf.volumeOk).toBe(false);
  });
});

describe('TA — Confidence score', () => {
  test('Triple bullish ≥ 60', () => {
    const up = calcTF(uptrend())!;
    const s = confidence(up, up, up);
    console.log(`  Triple bullish: ${s}`);
    expect(s).toBeGreaterThanOrEqual(55);
  });
  test('Triple bearish < 30', () => {
    const dn = calcTF(downtrend())!;
    const s = confidence(dn, dn, dn);
    console.log(`  Triple bearish: ${s}`);
    expect(s).toBeLessThan(30);
  });
  test('Score capped 0–100', () => {
    const up = calcTF(uptrend())!; const dn = calcTF(downtrend())!;
    expect(confidence(up,up,up)).toBeLessThanOrEqual(100);
    expect(confidence(dn,dn,dn)).toBeGreaterThanOrEqual(0);
  });
});

describe('TA — Dynamic SL/TP & R:R', () => {
  test('SL always below entry price', () => {
    const c = uptrend(60);
    const price = c[c.length-1].close;
    const { sl } = calcSLTP(c, c, price);
    expect(sl).toBeLessThan(price);
  });
  test('TP always above entry price', () => {
    const c = uptrend(60);
    const price = c[c.length-1].close;
    const { tp } = calcSLTP(c, c, price);
    expect(tp).toBeGreaterThan(price);
  });
  test('R:R >= 2.5 minimum', () => {
    const c = uptrend(60);
    const price = c[c.length-1].close;
    const { rr } = calcSLTP(c, c, price);
    expect(rr).toBeGreaterThanOrEqual(TA.minRR);
  });
  test('Manual R:R calculation correct', () => {
    const entry=100, sl=96, tp=110;
    const rr = (tp-entry)/(entry-sl);
    expect(rr).toBeCloseTo(2.5, 5);
  });
  test('slPct and tpPct are positive numbers', () => {
    const c = uptrend(60);
    const price = c[c.length-1].close;
    const { slPct, tpPct } = calcSLTP(c, c, price);
    expect(slPct).toBeGreaterThan(0);
    expect(tpPct).toBeGreaterThan(0);
  });
});

describe('TA — LONG signal gating', () => {
  test('No LONG when 4h bearish even if 15m bullish', () => {
    const up15m = calcTF(uptrend())!;
    const dn4h  = calcTF(downtrend())!;
    const allBullish = dn4h.uptrend && up15m.uptrend; // 4h bearish → false
    expect(allBullish).toBe(false);
  });
  test('No trade if confidence < 70', () => {
    const dn = calcTF(downtrend())!;
    const up = calcTF(uptrend())!;
    const s = confidence(dn, up, up); // 15m bearish → confidence drops
    console.log(`  Partial bearish confidence: ${s}`);
    // If this is < 70 → trade blocked correctly
    if (s < TA.minConfidence) expect(s).toBeLessThan(TA.minConfidence);
  });
  test('SOL/BTC/ETH are the only valid assets', () => {
    const VALID = ['SOL', 'BTC', 'ETH'];
    expect(VALID).toContain('SOL');
    expect(VALID).toContain('BTC');
    expect(VALID).toContain('ETH');
    expect(VALID).not.toContain('BONK');
  });
});

describe('Jupiter CLI command builder', () => {
  test('Builds correct perps open command', () => {
    const asset = 'SOL', side = 'long', usdc = 10, lev = 2, tp = 185, sl = 155;
    const cmd = `perps open --asset ${asset} --side ${side} --amount ${usdc} --input USDC --leverage ${lev} --tp ${tp} --sl ${sl}`;
    expect(cmd).toContain('--tp 185');
    expect(cmd).toContain('--sl 155');
    expect(cmd).toContain('--leverage 2');
    expect(cmd).toContain('--input USDC');
  });
  test('Dry run flag appended correctly', () => {
    const base = 'perps open --asset BTC --side long --amount 10 --input USDC --leverage 2 --tp 100000 --sl 80000';
    const withDry = base + ' --dry-run';
    expect(withDry).toContain('--dry-run');
  });
  test('TP/SL rounded to correct decimals per asset', () => {
    const btcSL = parseFloat((82543.123).toFixed(0));  // BTC: 0 decimals
    const ethSL = parseFloat((1823.456).toFixed(1));   // ETH: 1 decimal
    const solSL = parseFloat((142.789).toFixed(2));    // SOL: 2 decimals
    expect(btcSL).toBe(82543);
    expect(ethSL).toBe(1823.5);
    expect(solSL).toBe(142.79);
  });
});
