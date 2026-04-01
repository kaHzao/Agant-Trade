import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';
import { logger } from './logger';
import { sendAlert } from './telegram';
import { recordSL } from './riskGuard';
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getJupPath(): string {
  try { execSync('jup --version', { stdio: 'pipe', timeout: 5000 }); return 'jup'; } catch {}
  const win = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'jup.cmd');
  try { execSync(`"${win}" --version`, { stdio: 'pipe', timeout: 5000 }); return `"${win}"`; } catch {}
  return 'jup';
}
const JUP = getJupPath();

function jupCmd(args: string): any {
  try {
    const out = execSync(`${JUP} ${args} -f json`, { encoding: 'utf-8', timeout: 15000 });
    return JSON.parse(out);
  } catch { return null; }
}

function readTracker(): TrackerState {
  if (!fs.existsSync(TRACKER_FILE)) return { positions: {} };
  try { return JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf-8')); }
  catch { return { positions: {} }; }
}

function writeTracker(state: TrackerState) {
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(state, null, 2));
}

// ─── Fetch final PnL from jup perps history ──────────────────────────────────

async function getFinalPnL(asset: string, side: string, openedAt: number): Promise<{
  pnlUsd: number | null;
  closePrice: number | null;
  closeReason: 'TP' | 'SL' | 'MANUAL' | 'UNKNOWN';
} > {
  try {
    const history = jupCmd(`perps history --asset ${asset} --side ${side} --limit 5`);
    if (!history?.trades?.length) return { pnlUsd: null, closePrice: null, closeReason: 'UNKNOWN' };

    // Find the most recent "Decrease" trade after position was opened
    const closeTrade = history.trades.find((t: any) => {
      const tradeTime = new Date(t.time).getTime();
      return t.action === 'Decrease' && tradeTime >= openedAt;
    });

    if (!closeTrade) return { pnlUsd: null, closePrice: null, closeReason: 'UNKNOWN' };

    const pnlUsd    = closeTrade.pnlUsd ?? null;
    const closePrice = closeTrade.priceUsd ?? null;

    // Determine close reason from price vs TP/SL
    let closeReason: 'TP' | 'SL' | 'MANUAL' | 'UNKNOWN' = 'UNKNOWN';
    if (pnlUsd !== null) {
      closeReason = pnlUsd > 0 ? 'TP' : 'SL';
    }

    return { pnlUsd, closePrice, closeReason };
  } catch {
    return { pnlUsd: null, closePrice: null, closeReason: 'UNKNOWN' };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function detectClosedPositions(currentPositions: any[]): Promise<void> {
  const state = readTracker();
  const prevKeys = Object.keys(state.positions);
  if (prevKeys.length === 0) return;

  const currentKeys = new Set(
    currentPositions.map((p: any) => p.positionPubkey || p.asset)
  );

  for (const key of prevKeys) {
    if (!currentKeys.has(key)) {
      const pos = state.positions[key];
      logger.info(`Position closed: ${pos.asset} ${pos.side}`);

      // Fetch final PnL from history
      const { pnlUsd, closePrice, closeReason } = await getFinalPnL(
        pos.asset, pos.side, pos.openedAt
      );

      const duration  = Math.round((Date.now() - pos.openedAt) / 60000);
      const pnlStr    = pnlUsd !== null
        ? `${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(3)}`
        : 'Check jup.ag';
      const pnlEmoji  = pnlUsd === null ? '❓' : pnlUsd >= 0 ? '✅' : '❌';
      const reasonEmoji = closeReason === 'TP' ? '🎯' : closeReason === 'SL' ? '🛑' : '📋';

      const sideEmoji = pos.side === 'long' ? '🟢' : '🔴';

      await sendAlert(
        `${sideEmoji} *CLOSED: ${pos.asset} ${pos.side.toUpperCase()}*\n` +
        `${reasonEmoji} Reason: \`${closeReason}\`\n` +
        `Entry: \`$${pos.entryPrice.toLocaleString()}\`\n` +
        (closePrice ? `Close: \`$${closePrice.toLocaleString()}\`\n` : '') +
        `TP: \`$${pos.tpPrice?.toLocaleString() ?? 'N/A'}\`\n` +
        `SL: \`$${pos.slPrice?.toLocaleString() ?? 'N/A'}\`\n` +
        `PnL: \`${pnlStr}\` ${pnlEmoji}\n` +
        `Duration: \`${duration} min\``
      );

      // Record to risk guard
      if (pnlUsd !== null && pnlUsd < 0) {
        recordSL(pos.asset as Asset, Math.abs(pnlUsd));
      } else if (pnlUsd === null) {
        recordSL(pos.asset as Asset, 0.15); // fallback estimate
      }

      delete state.positions[key];
    }
  }

  writeTracker(state);
}

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
      logger.debug(`Tracking: ${pos.asset} ${pos.side}`);
    }
  }

  writeTracker(state);
}
