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

    // ATR — dari 1h, multiplier sekarang dynamic (2.0–3.5 berdasarkan volatilitas)
    // nilai ini hanya dipakai sebagai referensi default
    atrPeriod:      14,
    atrMultiplier:  2.5,

    // Volume spike filter — dinaikkan ke 1.5x (dari 1.2x) untuk kualitas sinyal lebih tinggi
    volumeMultiplier: 1.5,

    // ADX — harus > 28 untuk entry
    adxMin: 28,

    // MACD (1H) — standard settings
    macdFast:   12,
    macdSlow:   26,
    macdSignal: 9,

    // Bollinger Bands (1H)
    bbPeriod: 20,
    bbStdDev: 2,

    // EMA slope lookback (candles)
    emaSlopeLookback: 5,

    // Min confidence
    minConfidence: 70,

    // Min RR
    minRR: 2.5,
  },
};
