import { config, ASSETS } from './utils/config';
import { logger } from './utils/logger';
import { sendAlert } from './utils/telegram';
import { analyzeAsset } from './ta/index';
import { executeTrade, checkJupInstalled, getPositions, getMarketPrices } from './execution/jup';

async function main() {
  logger.info('═══ Jupiter Perps Agent starting ═══');
  logger.info(`Mode: ${config.trading.dryRun ? '⚠️  DRY RUN' : '🔴 LIVE'}`);
  logger.info(`Pairs: ${ASSETS.join(', ')} | Collateral: $${config.trading.collateralUsdc} USDC | ${config.trading.leverage}x`);

  // ── Check jup CLI installed ────────────────────────────────────────────
  if (!checkJupInstalled()) {
    const msg = '❌ `jup` CLI not installed. Run: `npm i -g @jup-ag/cli`';
    logger.error(msg);
    await sendAlert(msg);
    process.exit(1);
  }

  // ── Check existing open positions ──────────────────────────────────────
  const openPositions = getPositions();
  const openAssets = new Set(openPositions.map((p: any) => p.asset as string));
  logger.info(`Open positions: ${openPositions.length}`, openAssets.size ? { assets: [...openAssets] } : {});

  // ── Get current market prices for context ──────────────────────────────
  const prices = getMarketPrices();
  if (Object.keys(prices).length) {
    logger.info('Market prices', prices);
  }

  // ── Analyze all 3 assets ───────────────────────────────────────────────
  const results = await Promise.allSettled(ASSETS.map(a => analyzeAsset(a)));

  const signals = results
    .map((r, i) => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean);

  let tradesOpened = 0;

  for (const ta of signals) {
    if (!ta) continue;

    // Skip if already in a position for this asset
    if (openAssets.has(ta.asset)) {
      logger.info(`${ta.asset}: skipping — already in position`);
      continue;
    }

    if (ta.signal === 'HOLD') {
      logger.info(`${ta.asset}: HOLD (${ta.confidence}% confidence)`);
      continue;
    }

    if (ta.confidence < config.ta.minConfidence) {
      logger.info(`${ta.asset}: ${ta.signal} signal but confidence too low (${ta.confidence}% < ${config.ta.minConfidence}%)`);
      continue;
    }

    // ── Execute trade ──────────────────────────────────────────────────
    const result = await executeTrade(ta);

    if (result.success) {
      tradesOpened++;
      const emoji = ta.signal === 'LONG' ? '🟢' : '🔴';
      await sendAlert(
        `${emoji} *${ta.signal} ${ta.asset}* ${result.dryRun ? '_(DRY RUN)_' : ''}\n` +
        `Price: \`$${ta.currentPrice.toLocaleString()}\`\n` +
        `Collateral: \`$${result.collateralUsdc} USDC × ${result.leverage}x\`\n` +
        `SL: \`$${result.slPrice.toLocaleString()}\` (-${ta.slPct.toFixed(1)}%)\n` +
        `TP: \`$${result.tpPrice.toLocaleString()}\` (+${ta.tpPct.toFixed(1)}%)\n` +
        `R:R: \`${result.rrRatio.toFixed(1)}x\`\n` +
        `Confidence: \`${ta.confidence}%\`\n` +
        `Signal: ${ta.reason}` +
        (result.signature ? `\nTx: \`${result.signature.slice(0, 16)}...\`` : '')
      );
      logger.trade(`${ta.asset} ${ta.signal} opened`, result);
    } else {
      await sendAlert(
        `⚠️ *TRADE FAILED: ${ta.asset}*\n` +
        `Error: ${result.error}`
      );
      logger.error(`Trade failed: ${ta.asset}`, result.error);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────
  if (tradesOpened === 0) {
    logger.info('No trades opened this cycle — conditions not met');
  } else {
    logger.info(`Cycle complete: ${tradesOpened} trade(s) opened`);
  }

  logger.info('═══ Agent cycle complete ═══');
}

main().catch(async err => {
  logger.error('Fatal error', err);
  await sendAlert(`🚨 *Agent fatal error*\n\`${err.message}\``);
  process.exit(1);
});
