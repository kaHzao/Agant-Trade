import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { sendAlert } from './telegram';
import { recordSL, recordTP } from './riskGuard';
import { config } from './config';
import type { Asset } from './config';

const TRACKER_FILE = path.join(process.cwd(), 'positions-tracker.json');

interface TrackedPosition {
  asset:          string;
  side:           'long' | 'short';
  entryPrice:     number;
  size:           number;
  tpPrice?:       number;
  slPrice?:       number;
  openedAt:       number;
  positionPubkey?: string;
}

interface TrackerState {
  positions: Record<string, TrackedPosition>;
}

function readTracker(): TrackerState {
  if (!fs.existsSync(TRACKER_FILE)) return { positions: {} };
  try { return JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf-8')); }
  catch { return { positions: {} }; }
}

function writeTracker(state: TrackerState) {
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(state, null, 2));
}

// ─── Detect close reason ──────────────────────────────────────────────────────
// FIX: sign PnL SHORT diperbaiki

function detectCloseReason(
  pos: TrackedPosition,
  lastKnownPrice: number
): { closeReason: 'TP' | 'SL' | 'UNKNOWN'; pnlUsd: number | null } {

  if (!pos.slPrice || !pos.tpPrice || lastKnownPrice <= 0) {
    return { closeReason: 'UNKNOWN', pnlUsd: null };
  }

  const { collateralUsdc, leverage } = config.trading;
  const sl = pos.slPrice;
  const tp = pos.tpPrice;

  if (pos.side === 'long') {
    // LONG: profit jika harga naik ke TP, loss jika turun ke SL
    if (lastKnownPrice >= tp) {
      const pnlPct = ((tp - pos.entryPrice) / pos.entryPrice) * 100 * leverage;
      return { closeReason: 'TP', pnlUsd: (collateralUsdc * pnlPct) / 100 };
    }
    if (lastKnownPrice <= sl) {
      const pnlPct = ((sl - pos.entryPrice) / pos.entryPrice) * 100 * leverage; // negatif
      return { closeReason: 'SL', pnlUsd: (collateralUsdc * pnlPct) / 100 };
    }
  } else {
    // SHORT: profit jika harga turun ke TP, loss jika naik ke SL
    // FIX: sign SHORT SL/TP diperbaiki
    if (lastKnownPrice <= tp) {
      const pnlPct = ((pos.entryPrice - tp) / pos.entryPrice) * 100 * leverage; // positif
      return { closeReason: 'TP', pnlUsd: (collateralUsdc * pnlPct) / 100 };
    }
    if (lastKnownPrice >= sl) {
      const pnlPct = ((pos.entryPrice - sl) / pos.entryPrice) * 100 * leverage; // negatif
      return { closeReason: 'SL', pnlUsd: (collateralUsdc * pnlPct) / 100 };
    }
  }

  return { closeReason: 'UNKNOWN', pnlUsd: null };
}

// ─── Detect closed positions ──────────────────────────────────────────────────

export async function detectClosedPositions(
  currentPositions: any[],
  marketPrices: Record<string, number>
): Promise<void> {
  const state = readTracker();
  const prevKeys = Object.keys(state.positions);
  if (prevKeys.length === 0) return;

  const currentKeys = new Set(
    currentPositions.map((p: any) => p.positionPubkey || p.asset)
  );

  for (const key of prevKeys) {
    if (currentKeys.has(key)) continue;

    const pos = state.positions[key];
    logger.info(`Position closed: ${pos.asset} ${pos.side}`);

    const lastPrice = marketPrices[pos.asset] ?? 0;
    const { closeReason, pnlUsd } = detectCloseReason(pos, lastPrice);

    const duration    = Math.round((Date.now() - pos.openedAt) / 60_000);
    const pnlStr      = pnlUsd !== null ? `${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(3)}` : 'N/A';
    const pnlEmoji    = pnlUsd === null ? '❓' : pnlUsd >= 0 ? '✅' : '❌';
    const sideEmoji   = pos.side === 'long' ? '🟢' : '🔴';
    const reasonEmoji = closeReason === 'TP' ? '🎯' : closeReason === 'SL' ? '🛑' : '📋';

    await sendAlert(
      `${sideEmoji} *CLOSED: ${pos.asset} ${pos.side.toUpperCase()}*\n` +
      `${reasonEmoji} Reason: \`${closeReason}\`\n` +
      `Entry: \`$${pos.entryPrice.toLocaleString()}\`\n` +
      `Exit ~: \`$${lastPrice.toLocaleString()}\`\n` +
      `TP: \`$${pos.tpPrice?.toLocaleString() ?? 'N/A'}\`  SL: \`$${pos.slPrice?.toLocaleString() ?? 'N/A'}\`\n` +
      `PnL: \`${pnlStr}\` ${pnlEmoji}\n` +
      `Duration: \`${duration} min\``
    );

    const signal = pos.side === 'long' ? 'LONG' : 'SHORT';

    if (closeReason === 'SL') {
      const loss = pnlUsd !== null ? Math.abs(pnlUsd) : config.trading.collateralUsdc * 0.015;
      await recordSL(pos.asset as Asset, signal, loss);
    } else if (closeReason === 'TP') {
      recordTP(pos.asset as Asset, signal);
    } else {
      // UNKNOWN: assume SL untuk safety
      logger.warn(`${pos.asset} close UNKNOWN — assuming SL`);
      await recordSL(pos.asset as Asset, signal, config.trading.collateralUsdc * 0.015);
    }

    delete state.positions[key];
  }

  writeTracker(state);
}

// ─── Update tracker ───────────────────────────────────────────────────────────

export function updateTrackedPositions(currentPositions: any[]): void {
  const state = readTracker();

  for (const pos of currentPositions) {
    const key = pos.positionPubkey || pos.asset;
    if (state.positions[key]) continue; // sudah ditrack

    const tpPrice = pos.tpsl?.find((t: any) => t.type === 'tp')?.triggerPriceUsd;
    const slPrice = pos.tpsl?.find((t: any) => t.type === 'sl')?.triggerPriceUsd;

    state.positions[key] = {
      asset:          pos.asset,
      side:           pos.side,
      entryPrice:     pos.entryPriceUsd ?? pos.markPriceUsd ?? 0,
      size:           pos.sizeUsd ?? 0,
      tpPrice,
      slPrice,
      openedAt:       Date.now(),
      positionPubkey: pos.positionPubkey,
    };

    logger.debug(`Tracking ${pos.asset} ${pos.side} | TP:${tpPrice} SL:${slPrice}`);
  }

  writeTracker(state);
}
