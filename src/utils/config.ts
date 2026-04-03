import dotenv from 'dotenv';
dotenv.config();

export type Asset = 'SOL' | 'BTC' | 'ETH';
export const ASSETS: Asset[] = ['SOL', 'BTC', 'ETH'];

export const config = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId:   process.env.TELEGRAM_CHAT_ID   || '',
  },

  trading: {
    collateralUsdc: parseFloat(process.env.COLLATERAL_USDC || '10'),
    leverage:       parseFloat(process.env.LEVERAGE        || '2'),
    dryRun:         process.env.DRY_RUN !== 'false',
  },

  ta: {
    // ── EMA ──────────────────────────────────────────────────────────────────
    emaFast: 20,
    emaSlow: 50,

    // ── RSI ──────────────────────────────────────────────────────────────────
    rsiPeriod:   14,
    rsiBuyMin:   40,   // LONG floor
    rsiBuyMax:   65,   // LONG ceiling (diperlebar)
    rsiShortMin: 35,   // SHORT floor
    rsiShortMax: 60,   // SHORT ceiling

    // ── ATR ──────────────────────────────────────────────────────────────────
    atrPeriod:       14,
    atrMultiplier:   1.5,  // SL = ATR(1h) x 1.5
    atrTpMultiplier: 3.0,  // TP = ATR(1h) x 3.0 → RR ~2.0

    // ── Regime ───────────────────────────────────────────────────────────────
    adxTrending: 25,
    adxStrong:   30,

    // ── Filter ───────────────────────────────────────────────────────────────
    minConfidence:    75,   // naik dari 60
    volumeMultiplier: 1.2,

    // ── R:R gate (independen dari ATR multiplier) ─────────────────────────
    minRR: 1.8,
  },
};
