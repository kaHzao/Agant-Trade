import dotenv from 'dotenv';
dotenv.config();

export type Asset = 'SOL' | 'BTC' | 'ETH';
export const ASSETS: Asset[] = ['SOL', 'BTC', 'ETH'];

export const config = {
  binance: {
    baseUrl: 'https://api.binance.com',
    // Symbols for OHLCV
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
    emaFast: 9,
    emaSlow: 21,
    rsiPeriod: 14,
    rsiBuyMin: 45,
    rsiBuyMax: 60,
    rsiSellMin: 72,
    volumeMultiplier: 2.0,
    swingLookback: 10,
    minRR: 2.5,
    minConfidence: 70,
  },
};
