import { config, ASSETS } from './utils/config';
import { logger } from './utils/logger';
import { sendAlert } from './utils/telegram';
import { analyzeAll } from './ta/index';
import { executeTrade, checkJupInstalled, getPositions, getMarketPrices } from './execution/jup';
import { canTrade, recordTradeOpened, getDailyStatus } from './utils/riskGuard';
import { detectClosedPositions, updateTrackedPositions } from './utils/positionTracker';

async function main() {
  const startTime = Date.now();
  logger.info('═══ Jupiter Perps Agent starting ═══');
  logger.info(`Mode: ${config.trading.dryRun ? '⚠️  DRY RUN' : '🔴 LIVE'}`);
  logger.info(`Pairs: ${ASSETS.join(', ')} | $${config.trading.collateralUsdc} | ${config.trading.leverage}x`);
  logger.info(`Confidence gate: ${config.ta.minConfidence}% | RR min: ${config.ta.minRR} | Vol: ${config.ta.volumeMultiplier}x`);

  // ── Check jup CLI ──────────────────────────────────────────────────────────
  if (!checkJupInstalled()) {
    const msg = '❌ `jup` CLI not installed';
    logger.error(msg);
    await sendAlert(msg);
    process.exit(1);
  }

  // ── Daily risk status ──────────────────────────────────────────────────────
  logger.info(getDailyStatus());

  // ── Open positions ─────────────────────────────────────────────────────────
  const openPositions = getPositions();
  const openAssets    = new Set(openPositions.map((p: any) => p.asset as string));
  logger.info(`Open positions: ${openPositions.length} (${[...openAssets].join(', ') || 'none'})`);

  // ── Market prices ──────────────────────────────────────────────────────────
  const prices = getMarketPrices();
  if (Object.keys(prices).length) {
    logger.info('Market prices', prices);
  }

  // ── Detect closed positions (TP/SL hit) ───────────────────────────────────
  await detectClosedPositions(openPositions, prices);
  updateTrackedPositions(openPositions);

  // ── Run TA — selalu dijalankan meski semua pair in position ────────────────
  // Alasan: perlu deteksi reversal signal pada posisi yang sedang open
  const signals = await analyzeAll();
  let tradesOpened = 0;

  for (const ta of signals) {
    if (!ta) continue;

    if (openAssets.has(ta.asset)) {
      // ── Reversal detection: signal berlawanan dengan posisi open ────────────
      if (ta.signal !== 'HOLD' && ta.confidence >= config.ta.minConfidence) {
        const openPos = openPositions.find((p: any) => p.asset === ta.asset);
        if (openPos) {
          const posSide = (openPos.side as string).toLowerCase();     // 'long' / 'short'
          const sigSide = ta.signal.toLowerCase();                    // 'long' / 'short'

          if (posSide !== sigSide) {
            const posEmoji = posSide === 'long' ? '🟢' : '🔴';
            const sigEmoji = ta.signal === 'LONG' ? '🟢' : '🔴';
            const entryPrice = openPos.entryPriceUsd ?? openPos.markPriceUsd ?? 0;

            logger.warn(
              `⚠️  REVERSAL ${ta.asset}: pos ${posSide.toUpperCase()} vs signal ${ta.signal} ` +
              `conf:${ta.confidence}% MACD:${ta.macdHistogram.toFixed(4)}`
            );

            await sendAlert(
              `⚠️ *REVERSAL SIGNAL: ${ta.asset}*\n` +
              `${posEmoji} Posisi open: \`${posSide.toUpperCase()}\`` +
              `${entryPrice > 0 ? ` @ \`$${entryPrice.toLocaleString()}\`` : ''}\n` +
              `${sigEmoji} Signal baru: \`${ta.signal}\` conf:\`${ta.confidence}%\`\n` +
              `RSI: \`${ta.rsi.toFixed(1)}\` | ADX: \`${ta.adx.toFixed(0)}${ta.adxRising ? '↑' : '↓'}\`\n` +
              `MACD: ${ta.macdHistogram > 0 ? '🟢' : '🔴'}\`${ta.macdHistogram.toFixed(5)}\` | ` +
              `BB: \`${(ta.bbPosition * 100).toFixed(0)}%\`${ta.bbSqueeze ? ' 🔄' : ''}\n` +
              `_→ Pertimbangkan close manual_`
            );
          }
        }
      }

      logger.info(`${ta.asset}: already in position, skipping entry`);
      continue;
    }

    if (ta.signal === 'HOLD') {
      logger.info(
        `${ta.asset}: HOLD | ${ta.regime} | ADX:${ta.adx.toFixed(0)}${ta.adxRising ? '↑' : '↓'} | ` +
        `conf:${ta.confidence}% | RSI:${ta.rsi.toFixed(1)} | ${ta.reason}`
      );
      continue;
    }

    // ── Risk guard ─────────────────────────────────────────────────────────
    const guard = canTrade(ta.asset);
    if (!guard.allowed) {
      logger.warn(`${ta.asset}: BLOCKED — ${guard.reason}`);
      await sendAlert(`⛔ *${ta.asset} blocked*\n${guard.reason}`);
      continue;
    }

    // ── Execute ────────────────────────────────────────────────────────────
    logger.info(`🎯 ${ta.signal} ${ta.asset} | conf:${ta.confidence}% | ${ta.reason}`);
    const result = await executeTrade(ta);

    if (result.success) {
      tradesOpened++;
      openAssets.add(ta.asset);
      recordTradeOpened(ta.asset);

      const macdEmoji = ta.macdHistogram > 0 ? '🟢' : '🔴';
      const bbPct     = (ta.bbPosition * 100).toFixed(0);
      const emoji     = ta.signal === 'LONG' ? '🟢' : '🔴';
      await sendAlert(
        `${emoji} *${ta.signal} ${ta.asset}*${result.dryRun ? ' _(DRY RUN)_' : ''}\n` +
        `Price: \`$${ta.currentPrice.toLocaleString()}\`\n` +
        `Collateral: \`$${result.collateralUsdc} × ${result.leverage}x\`\n` +
        `SL: \`$${result.slPrice.toLocaleString()}\` (-${ta.slPct.toFixed(2)}%)\n` +
        `TP: \`$${result.tpPrice.toLocaleString()}\` (+${ta.tpPct.toFixed(2)}%)\n` +
        `R:R: \`${result.rrRatio.toFixed(2)}x\`\n` +
        `Regime: ${ta.regime} | ADX:${ta.adx.toFixed(0)}${ta.adxRising ? '↑' : ''} | Conf:${ta.confidence}%\n` +
        `MACD: ${macdEmoji}\`${ta.macdHistogram.toFixed(5)}\` | BB: \`${bbPct}%\`${ta.bbSqueeze ? ' 🔄' : ''} | Slope: \`${ta.emaSlope1h.toFixed(3)}%\`\n` +
        `Signal: ${ta.reason}`
      );
    } else {
      logger.error(`Trade failed: ${ta.asset}`, result.error);
      await sendAlert(`⚠️ *Trade failed: ${ta.asset}*\n${result.error}`);
    }
  }

  if (tradesOpened === 0) {
    logger.info('No trades opened this cycle');
  }

  logger.info(`═══ Cycle complete (${Date.now() - startTime}ms) ═══\n`);
}

main().catch(async err => {
  logger.error('Fatal error', err);
  await sendAlert(`🚨 *Agent error*\n\`${err.message}\``);
  process.exit(1);
});
