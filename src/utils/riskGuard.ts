import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import type { Asset } from './config';

const GUARD_FILE = path.join(process.cwd(), 'risk-guard.json');

interface AssetGuard {
  lastSLTime?: number;
  lastSLPrice?: number;
  tradesToday: number;
  lossToday: number;
}

interface GuardState {
  date: string;
  assets: Record<string, AssetGuard>;
  totalLossToday: number;
}

function readGuard(): GuardState {
  const today = new Date().toISOString().split('T')[0];
  if (!fs.existsSync(GUARD_FILE)) {
    return { date: today, assets: {}, totalLossToday: 0 };
  }
  try {
    const state = JSON.parse(fs.readFileSync(GUARD_FILE, 'utf-8')) as GuardState;
    if (state.date !== today) {
      logger.info('New day — resetting daily risk guard stats');
      return { date: today, assets: {}, totalLossToday: 0 };
    }
    return state;
  } catch {
    return { date: today, assets: {}, totalLossToday: 0 };
  }
}

function writeGuard(state: GuardState) {
  fs.writeFileSync(GUARD_FILE, JSON.stringify(state, null, 2));
}

function getAsset(state: GuardState, asset: Asset): AssetGuard {
  if (!state.assets[asset]) {
    state.assets[asset] = { tradesToday: 0, lossToday: 0 };
  }
  return state.assets[asset];
}

export const COOLDOWN_HOURS     = 3;
export const MAX_TRADES_PER_DAY = 2;
export const MAX_DAILY_LOSS     = 1.5;
export const MAX_LOSS_PER_ASSET = 0.5;

export interface GuardCheck {
  allowed: boolean;
  reason?: string;
}

export function canTrade(asset: Asset): GuardCheck {
  const state = readGuard();
  const g = getAsset(state, asset);
  const now = Date.now();

  if (g.lastSLTime) {
    const hoursSinceSL = (now - g.lastSLTime) / (1000 * 60 * 60);
    if (hoursSinceSL < COOLDOWN_HOURS) {
      const remaining = (COOLDOWN_HOURS - hoursSinceSL).toFixed(1);
      return {
        allowed: false,
        reason: `Cooldown after SL: ${remaining}h remaining (SL hit ${hoursSinceSL.toFixed(1)}h ago)`
      };
    }
  }

  if (g.tradesToday >= MAX_TRADES_PER_DAY) {
    return {
      allowed: false,
      reason: `Max trades reached for ${asset} today (${g.tradesToday}/${MAX_TRADES_PER_DAY})`
    };
  }

  if (g.lossToday >= MAX_LOSS_PER_ASSET) {
    return {
      allowed: false,
      reason: `Max loss reached for ${asset} today ($${g.lossToday.toFixed(2)}/$${MAX_LOSS_PER_ASSET})`
    };
  }

  if (state.totalLossToday >= MAX_DAILY_LOSS) {
    return {
      allowed: false,
      reason: `Daily loss limit reached ($${state.totalLossToday.toFixed(2)}/$${MAX_DAILY_LOSS}) — STOPPING`
    };
  }

  return { allowed: true };
}

export function recordSL(asset: Asset, signal: string, pnlUsd: number) {
  const state = readGuard();
  const g = getAsset(state, asset);
  const loss = Math.abs(pnlUsd);

  g.lastSLTime = Date.now();
  g.lossToday = (g.lossToday || 0) + loss;
  state.totalLossToday = (state.totalLossToday || 0) + loss;

  writeGuard(state);
  logger.warn(`SL recorded for ${asset} ${signal}: -$${loss.toFixed(2)} | Total loss today: $${state.totalLossToday.toFixed(2)}`);
}

export function recordTP(asset: Asset, signal: string) {
  const state = readGuard();
  getAsset(state, asset); // ensure asset exists
  writeGuard(state);
  logger.info(`TP recorded for ${asset} ${signal}`);
}

export function recordTradeOpened(asset: Asset) {
  const state = readGuard();
  const g = getAsset(state, asset);
  g.tradesToday = (g.tradesToday || 0) + 1;
  writeGuard(state);
  logger.info(`Trade recorded for ${asset}: ${g.tradesToday} trades today`);
}

export function getDailyStatus(): string {
  const state = readGuard();
  const lines = [`Daily Status (${state.date}):`];
  lines.push(`Total loss: $${state.totalLossToday.toFixed(2)}/$${MAX_DAILY_LOSS}`);

  for (const [asset, g] of Object.entries(state.assets)) {
    const cooldownInfo = g.lastSLTime
      ? `SL ${((Date.now() - g.lastSLTime) / 3600000).toFixed(1)}h ago`
      : 'No SL';
    lines.push(`${asset}: ${g.tradesToday} trades | loss $${(g.lossToday || 0).toFixed(2)} | ${cooldownInfo}`);
  }

  return lines.join('\n');
}
