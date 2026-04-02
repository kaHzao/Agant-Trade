import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { sendAlert } from './telegram';
import { recordSL, recordTP } from './riskGuard';
import type { Asset } from './config';

const TRACKER_FILE = path.join(process.cwd(), 'positions-tracker.json');

interface TrackedPosition {
  asset: string;
  side: string;
  entryPrice: number;
  size: number;
  tpPrice?: number;
  slPrice?: number;
  openedAt: number;
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

// ─── Detect close reason dari market prices (tidak perlu jup history) ─────────

function detectCloseReason(
  pos: TrackedPosition,
  lastKnownPrice: number
): { closeReason: 'TP' | 'SL' | 'UNKNOWN'; pnlUsd: number | null } {

  if (!pos.slPrice || !pos.tpPrice) {
    return { closeReason: 'UNKNOWN', pnlUsd: null };
  }

  const sl = pos.slPrice;
  const tp = pos.tpPrice;

  if (pos.side === 'short') {
    // SHORT: profit jika harga turun
    // TP = harga turun ke tp level
    // SL = harga naik ke sl level
    if (lastKnownPrice <= tp) {
      const pnlPct = ((pos.entryPrice - tp) / pos.entryPrice) * 100 * 2; // 2x leverage
      const pnlUsd = (10 * pnlPct) / 100;
      return { closeReason: 'TP', pnlUsd };
    }
    if (lastKnownPrice >= sl) {
      const pnlPct = ((pos.entryPrice - sl) / pos.entryPrice) * 100 * 2;
      const pnlUsd = (10 * pnlPct) / 100; // akan negatif
      return { closeReason: 'SL', pnlUsd };
    }
  } else {
    // LONG: profit jika harga naik
    if (lastKnownPrice >= tp) {
      const pnlPct = ((tp - pos.entryPrice) / pos.entryPrice) * 100 * 2;
      const pnlUsd = (10 * pnlPct) / 100;
      return { closeReason: 'TP', pnlUsd };
    }
    if (lastKnownPrice <= sl) {
      const pnlPct = ((sl - pos.entryPrice) / pos.entryPrice) * 100 * 2;
      const pnlUsd = (10 * pnlPct) / 100; // negatif
      return { closeReason: 'SL', pnlUsd };
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
    if (!currentKeys.has(key)) {
      const pos = state.positions[key];
      logger.info(`Position closed detected: ${pos.asset} ${pos.side}`);

      // Gunakan market price untuk detect TP/SL
      const lastPrice = marketPrices[pos.asset] || 0;
      const { closeReason, pnlUsd } = detectCloseReason(pos, lastPrice);

      const duration   = Math.round((Date.now() - pos.openedAt) / 60000);
      const pnlStr     = pnlUsd !== null ? `${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(3)}` : 'N/A';
      const pnlEmoji   = pnlUsd === null ? '❓' : pnlUsd >= 0 ? '✅' : '❌';
      const sideEmoji  = pos.side === 'long' ? '🟢' : '🔴';
      const reasonEmoji = closeReason === 'TP' ? '🎯' : closeReason === 'SL' ? '🛑' : '📋';

      await sendAlert(
        `${sideEmoji} *CLOSED: ${pos.asset} ${pos.side.toUpperCase()}*\n` +
        `${reasonEmoji} Reason: \`${closeReason}\`\n` +
        `Entry: \`$${pos.entryPrice.toLocaleString()}\`\n` +
        `TP: \`$${pos.tpPrice?.toLocaleString() ?? 'N/A'}\`\n` +
        `SL: \`$${pos.slPrice?.toLocaleString() ?? 'N/A'}\`\n` +
        `PnL: \`${pnlStr}\` ${pnlEmoji}\n` +
        `Duration: \`${duration} min\``
      );

      // Update risk guard
      const signal = pos.side === 'long' ? 'LONG' : 'SHORT';
      if (closeReason === 'SL') {
        const loss = pnlUsd !== null ? Math.abs(pnlUsd) : 0.15;
        await recordSL(pos.asset as Asset, signal, loss);
        logger.warn(`SL recorded: ${pos.asset} ${signal} -$${loss.toFixed(3)}`);
      } else if (closeReason === 'TP') {
        recordTP(pos.asset as Asset, signal);
        logger.info(`TP recorded: ${pos.asset} ${signal} +$${pnlUsd?.toFixed(3)}`);
      } else {
        // UNKNOWN — assume SL untuk safety (tetap update counter)
        logger.warn(`${pos.asset} close reason UNKNOWN — assuming SL for safety`);
        await recordSL(pos.asset as Asset, signal, 0.15);
      }

      delete state.positions[key];
    }
  }

  writeTracker(state);
}

// ─── Update tracker ───────────────────────────────────────────────────────────

export function updateTrackedPositions(currentPositions: any[]): void {
  const state = readTracker();

  for (const pos of currentPositions) {
    const key = pos.positionPubkey || pos.asset;
    if (!state.positions[key]) {
      state.positions[key] = {
        asset: pos.asset,
        side: pos.side,
        entryPrice: pos.entryPriceUsd ?? pos.markPriceUsd ?? 0,
        size: pos.sizeUsd ?? 0,
        tpPrice: pos.tpsl?.find((t: any) => t.type === 'tp')?.triggerPriceUsd,
        slPrice: pos.tpsl?.find((t: any) => t.type === 'sl')?.triggerPriceUsd,
        openedAt: Date.now(),
        positionPubkey: pos.positionPubkey,
      };
      logger.debug(`Tracking: ${pos.asset} ${pos.side} | TP:${pos.tpsl?.find((t:any)=>t.type==='tp')?.triggerPriceUsd} SL:${pos.tpsl?.find((t:any)=>t.type==='sl')?.triggerPriceUsd}`);
    }
  }

  writeTracker(state);
}
