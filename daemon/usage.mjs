// Plan usage tracking: the weekly and 5-hour ("session") usage percentages
// for each agent.
//
// Claude: the percentages only appear in the status line payload, so
//   hooks/statusline.sh forwards that payload to POST /usage.
// Codex: the CLI records them in its session rollout files, which we read.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SESSION_WINDOW_MAX_MINUTES = 24 * 60; // anything up to a day counts as the short "session" window
const TAIL_BYTES = 512 * 1024;
const RECENT_FILES = 3;

export class UsageStore {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.usage = { claude: {}, codex: {} }; // agent -> { week?, session? }, each { pct, resetsAt }
  }

  // Returns true if anything changed.
  set(agent, windows) {
    if (!windows || !this.usage[agent]) return false;
    const before = JSON.stringify(this.usage[agent]);
    this.usage[agent] = { week: windows.week || null, session: windows.session || null };
    return before !== JSON.stringify(this.usage[agent]);
  }

  // Current percent for a window, 0 once its reset time has passed, -1 if unknown.
  percent(agent, window) {
    const w = this.usage[agent]?.[window];
    if (!w || !Number.isFinite(w.pct)) return -1;
    if (w.resetsAt && this.now() / 1000 > w.resetsAt) return 0;
    return Math.max(0, Math.min(100, Math.round(w.pct)));
  }

  // Compact form for the device: { c: [week, session], x: [week, session] }
  wire() {
    return {
      c: [this.percent('claude', 'week'), this.percent('claude', 'session')],
      x: [this.percent('codex', 'week'), this.percent('codex', 'session')],
    };
  }
}

// Claude Code status line payload: { rate_limits: { five_hour, seven_day } }
export function fromClaudeStatusline(payload) {
  const limits = payload?.rate_limits;
  if (!limits) return null;
  const read = (w) => (w && Number.isFinite(w.used_percentage) ? { pct: w.used_percentage, resetsAt: w.resets_at || 0 } : null);
  return { week: read(limits.seven_day), session: read(limits.five_hour) };
}

// Codex rate_limits record: { primary, secondary }, each { used_percent, window_minutes, resets_at }.
// Which slot holds which window varies by plan, so classify by window length.
export function fromCodexRateLimits(limits) {
  if (!limits) return null;
  const out = { week: null, session: null };
  for (const w of [limits.primary, limits.secondary]) {
    if (!w || !Number.isFinite(w.used_percent)) continue;
    const slot = (w.window_minutes || 0) <= SESSION_WINDOW_MAX_MINUTES ? 'session' : 'week';
    out[slot] = { pct: w.used_percent, resetsAt: w.resets_at || 0 };
  }
  return out;
}

// Reads the most recent rate_limits record from Codex's rollout files.
export function readCodexUsage(root = path.join(os.homedir(), '.codex', 'sessions')) {
  let best = null;
  for (const file of recentRollouts(root)) {
    const record = lastRateLimits(file);
    if (record && (!best || record.timestamp > best.timestamp)) best = record;
  }
  return best ? fromCodexRateLimits(best.limits) : null;
}

function recentRollouts(root) {
  // Layout is <root>/YYYY/MM/DD/rollout-*.jsonl; walk newest directories first.
  const files = [];
  const newestFirst = (dir) => {
    try {
      return fs.readdirSync(dir).sort().reverse().map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  };
  for (const year of newestFirst(root)) {
    for (const month of newestFirst(year)) {
      for (const day of newestFirst(month)) {
        for (const file of newestFirst(day)) {
          if (!file.endsWith('.jsonl')) continue;
          try {
            files.push({ file, mtime: fs.statSync(file).mtimeMs });
          } catch {}
        }
        if (files.length >= RECENT_FILES) {
          return files.sort((a, b) => b.mtime - a.mtime).slice(0, RECENT_FILES).map((f) => f.file);
        }
      }
    }
  }
  return files.map((f) => f.file);
}

function lastRateLimits(file) {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    try {
      const entry = JSON.parse(lines[i]);
      const limits = entry.payload?.rate_limits || entry.payload?.info?.rate_limits || entry.rate_limits;
      if (limits) return { limits, timestamp: Date.parse(entry.timestamp) || 0 };
    } catch {
      // A line cut off at the start of the tail window; keep looking.
    }
  }
  return null;
}
