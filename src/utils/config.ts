import dotenv from 'dotenv';
dotenv.config();

export type Asset = 'SOL' | 'BTC' | 'ETH';
export const ASSETS: Asset[] = ['SOL', 'BTC', 'ETH'];

export const config = {
  binance: {
    baseUrl: 'https://api.binance.com',
    symbols: {
      SOL: 'SOLUSDT',
      BTC: 'BTCUSDT',
      ETH: 'ETHUSDT',
    } as Record<Asset, string>,
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  trading: {
    collateralUsdc: parseFloat(process.env.COLLATERAL_USDC || '10'),
    leverage: parseFloat(process.env.LEVERAGE || '2'),
    dryRun: process.env.DRY_RUN !== 'false',
  },
  ta: {
    // EMA
    emaFast: 9,
    emaSlow: 21,

    // RSI
    rsiPeriod: 14,
    rsiBuyMin: 45,       // LONG entry RSI min
    rsiBuyMax: 60,       // LONG entry RSI max
    rsiShortMin: 40,     // SHORT entry RSI min
    rsiShortMax: 60,     // SHORT entry RSI max
    rsiSellMin: 72,      // Overbought → SHORT trigger

    // ATR (dynamic SL/TP)
    atrPeriod: 14,
    atrMultiplier: 1.5,  // SL = price ± ATR × 1.5

    // Bollinger Bands (sideways strategy)
    bbPeriod: 20,
    bbStdDev: 2,

    // Regime detection
    atrSidewaysThreshold: 1.5, // ATR% < 1.5 = sideways

    // General
    volumeMultiplier: 1.3,
    swingLookback: 10,
    minRR: 2.5,
    minConfidence: 60,
  },
};
