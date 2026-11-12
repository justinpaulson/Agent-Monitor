// Token totals for a session, read from the agent's own transcript file.
//
// "Tokens" here means new tokens: input that was not served from the prompt
// cache, plus output. Cache reads are left out because they dwarf everything
// else (often 95%+ of the raw total) and say little about the work done.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions');

export async function readTokens(session) {
  try {
    if (session.agent === 'codex') {
      const file = session.transcriptPath || findCodexRollout(session.id);
      return file ? await readCodexTokens(file) : null;
    }
    return session.transcriptPath ? await readClaudeTokens(session.transcriptPath) : null;
  } catch {
    return null;
  }
}

async function eachLine(file, visit) {
  const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) visit(line);
}

// Claude Code transcript: one line per content block, each repeating the usage
// of the API response it belongs to, so count each response once by message id.
async function readClaudeTokens(file) {
  const perMessage = new Map();
  await eachLine(file, (line) => {
    if (!line.includes('"usage"')) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const usage = entry.type === 'assistant' && entry.message?.usage;
    if (!usage) return;
    perMessage.set(
      entry.message.id || perMessage.size,
      (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0),
    );
  });
  if (!perMessage.size) return null;
  let total = 0;
  for (const n of perMessage.values()) total += n;
  return total;
}

// Codex rollout: token_count events carry a running total for the session.
async function readCodexTokens(file) {
  let total = null;
  await eachLine(file, (line) => {
    if (!line.includes('"total_token_usage"')) return;
    try {
      const usage = JSON.parse(line).payload?.info?.total_token_usage;
      if (usage) total = (usage.input_tokens || 0) - (usage.cached_input_tokens || 0) + (usage.output_tokens || 0);
    } catch {}
  });
  return total;
}

// Rollout files are named rollout-<time>-<session id>.jsonl under YYYY/MM/DD.
function findCodexRollout(sessionId) {
  const newestFirst = (dir) => {
    try {
      return fs.readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  let daysChecked = 0;
  for (const year of newestFirst(CODEX_SESSIONS)) {
    for (const month of newestFirst(path.join(CODEX_SESSIONS, year))) {
      for (const day of newestFirst(path.join(CODEX_SESSIONS, year, month))) {
        const dir = path.join(CODEX_SESSIONS, year, month, day);
        const match = newestFirst(dir).find((name) => name.endsWith(`${sessionId}.jsonl`));
        if (match) return path.join(dir, match);
        if (++daysChecked >= 14) return null; // long-running sessions are rare; stop looking after two weeks
      }
    }
  }
  return null;
}
