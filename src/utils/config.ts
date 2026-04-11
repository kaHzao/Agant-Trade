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
    // EMA trend
    emaFast: 20,
    emaSlow: 50,

    // RSI
    rsiPeriod: 14,

    // ATR — sekarang dari 1h, multiplier 2.5
    atrPeriod:       14,
    atrMultiplier:   2.5,

    // Volume spike filter
    volumeMultiplier: 1.2,

    // ADX — harus > 28 untuk entry
    adxMin: 28,

    // Min confidence
    minConfidence: 65,

    // Min RR — naik ke 2.5
    minRR: 2.5,
  },
};
