import fs from 'fs';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

// ─── Types ────────────────────────────────────────────────────────────────────

interface AssetGuard {
  tradesToday:       number;
  lossToday:         number;
  lastSLTime?:       number;
  longConsecLoss:    number;
  shortConsecLoss:   number;
  longBlockedUntil?:  number;
  shortBlockedUntil?: number;
}

interface GuardState {
  date:            string;
  assets:          Record<string, AssetGuard>;
  totalLossToday:  number;
}

interface TrackedPosition {
  asset:       string;
  side:        string;
  entryPrice:  number;
  tpPrice?:    number;
  slPrice?:    number;
  openedAt:    number;
}

interface TrackerState {
  positions: Record<string, TrackedPosition>;
}

// ─── Read state files ─────────────────────────────────────────────────────────

function readGuard(): GuardState | null {
  const f = path.join(process.cwd(), 'risk-guard.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); }
  catch { return null; }
}

function readTracker(): TrackerState {
  const f = path.join(process.cwd(), 'positions-tracker.json');
  if (!fs.existsSync(f)) return { positions: {} };
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); }
  catch { return { positions: {} }; }
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(msg: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.error('Telegram not configured'); return; }

  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id:    chatId,
    text:       msg,
    parse_mode: 'Markdown',
  });
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function pnlStr(v: number): string {
  return `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`;
}

function blockStatus(g: AssetGuard): string {
  const now = Date.now();
  const parts: string[] = [];
  if (g.longBlockedUntil && now < g.longBlockedUntil) {
    parts.push(`LONG blocked ${((g.longBlockedUntil - now) / 3600000).toFixed(1)}h`);
  }
  if (g.shortBlockedUntil && now < g.shortBlockedUntil) {
    parts.push(`SHORT blocked ${((g.shortBlockedUntil - now) / 3600000).toFixed(1)}h`);
  }
  return parts.join(' | ') || 'clear';
}

// ─── Build reflection message ─────────────────────────────────────────────────

function buildMessage(): string {
  const guard   = readGuard();
  const tracker = readTracker();
  const now     = new Date();

  // Format tanggal WIB
  const dateStr = now.toLocaleDateString('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const lines: string[] = [];
  lines.push(`📊 *Daily Reflection — Agant-Trade*`);
  lines.push(`📅 ${dateStr}`);
  lines.push('');

  // ── Today's summary ────────────────────────────────────────────────────────
  if (!guard) {
    lines.push('_Belum ada data trading hari ini._');
  } else {
    const assets = Object.entries(guard.assets);
    const totalTrades = assets.reduce((s, [, g]) => s + (g.tradesToday || 0), 0);
    const totalLoss   = guard.totalLossToday || 0;

    lines.push(`*Ringkasan Hari Ini*`);
    lines.push(`Total trade: \`${totalTrades}\``);
    lines.push(`Total loss: \`${pnlStr(-totalLoss)}\``);
    lines.push('');

    // Per-asset breakdown
    if (assets.length > 0) {
      lines.push(`*Per Asset*`);
      for (const [asset, g] of assets) {
        const trades  = g.tradesToday || 0;
        const loss    = g.lossToday   || 0;
        const lStreak = g.longConsecLoss  || 0;
        const sStreak = g.shortConsecLoss || 0;
        const block   = blockStatus(g);

        const emoji = loss === 0 ? '⚪' : loss < 0.2 ? '🟡' : '🔴';
        lines.push(
          `${emoji} *${asset}*: ${trades} trade | loss \`${pnlStr(-loss)}\` | ` +
          `streak L:${lStreak} S:${sStreak} | ${block}`
        );
      }
      lines.push('');
    }
  }

  // ── Open positions ─────────────────────────────────────────────────────────
  const openPos = Object.values(tracker.positions);
  if (openPos.length > 0) {
    lines.push(`*Posisi Terbuka (${openPos.length})*`);
    for (const pos of openPos) {
      const duration = Math.round((Date.now() - pos.openedAt) / 60_000);
      const sideEmoji = pos.side === 'long' ? '🟢' : '🔴';
      lines.push(
        `${sideEmoji} *${pos.asset} ${pos.side.toUpperCase()}*\n` +
        `   Entry: \`$${pos.entryPrice.toLocaleString()}\` | ` +
        `TP: \`$${pos.tpPrice?.toLocaleString() ?? '—'}\` | ` +
        `SL: \`$${pos.slPrice?.toLocaleString() ?? '—'}\`\n` +
        `   Durasi: \`${duration} menit\``
      );
    }
    lines.push('');
  } else {
    lines.push(`*Posisi Terbuka*: tidak ada`);
    lines.push('');
  }

  // ── AI insight ─────────────────────────────────────────────────────────────
  lines.push(`*Insight*`);

  if (!guard) {
    lines.push(`_Agent baru aktif atau belum ada trade hari ini. Filter ADX aktif — agent hanya entry saat market trending._`);
  } else {
    const totalTrades = Object.values(guard.assets).reduce((s, g) => s + (g.tradesToday || 0), 0);
    const totalLoss   = guard.totalLossToday || 0;
    const anyBlocked  = Object.values(guard.assets).some(g => {
      const now = Date.now();
      return (g.longBlockedUntil && now < g.longBlockedUntil) ||
             (g.shortBlockedUntil && now < g.shortBlockedUntil);
    });

    if (totalTrades === 0) {
      lines.push(`_Market sideways hari ini — ADX rendah di semua pair, agent benar tidak entry. Lebih baik tidak trade daripada masuk di kondisi choppy._`);
    } else if (totalLoss === 0) {
      lines.push(`_Hari bersih — tidak ada loss yang tercatat. Posisi terbuka sedang berjalan._`);
    } else if (totalLoss >= 1.0) {
      lines.push(`_Loss hari ini cukup besar (\`${pnlStr(-totalLoss)}\`). Risk guard akan lebih ketat besok. Review kondisi market sebelum agent kembali aktif._`);
    } else if (anyBlocked) {
      lines.push(`_Ada pair yang sedang diblok karena consecutive SL. Ini normal — agent sedang cooling down. Block akan release otomatis._`);
    } else {
      lines.push(`_Performa hari ini dalam batas normal. Agent aktif dengan filter ketat — hanya entry di trending market._`);
    }
  }

  lines.push('');
  lines.push(`_Agant-Trade v2 · ${now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB_`);

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[reflection] Building daily summary...');
  const msg = buildMessage();
  console.log('[reflection] Sending to Telegram...');
  await sendTelegram(msg);
  console.log('[reflection] Done.');
}

main().catch(err => {
  console.error('[reflection] Error:', err.message);
  process.exit(1);
});
