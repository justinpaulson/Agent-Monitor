// Live Claude plan usage, fetched from Anthropic with the login Claude Code
// already has on this machine.
//
// The status line only reports usage in terminal sessions, so sessions run from
// the Claude desktop app would otherwise show nothing. This asks the same
// endpoint Claude Code's own /usage screen uses. The endpoint is not publicly
// documented and may change; every failure here is non-fatal and just leaves
// the usage rings empty.
//
// Two logins are tried, in order:
//   1. The monitor's own long-lived token, saved by bin/claude-login.mjs
//      (made with `claude setup-token`; lasts a year, can be revoked).
//   2. Claude Code's own login. That one is short-lived and only renewed while
//      Claude Code runs in a terminal, so on its own it goes stale for people
//      who mostly use the desktop app.
//
// The token is read fresh for each request, held only in memory, sent only to
// api.anthropic.com, and never logged. Claude Code's login is never refreshed
// here, so this cannot sign you out.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const OWN_KEYCHAIN_SERVICE = 'agent-monitor-claude-token';
const CLAUDE_CODE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const REQUEST_TIMEOUT_MS = 8000;

// Resolves to { week, session } (each { pct, resetsAt } or null), or throws an
// Error whose message is safe to log.
export async function fetchClaudeUsage() {
  const token = await readAccessToken();
  let response;
  try {
    response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`request failed (${err.name})`);
  }
  if (!response.ok) {
    const error = new Error(`Anthropic answered ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return parseUsage(await response.json());
}

export function parseUsage(body) {
  const read = (w) => {
    const pct = w?.utilization ?? w?.used_percentage;
    if (!Number.isFinite(pct)) return null;
    return { pct, resetsAt: toEpochSeconds(w.resets_at) };
  };
  return { week: read(body?.seven_day), session: read(body?.five_hour) };
}

function toEpochSeconds(value) {
  if (Number.isFinite(value)) return value > 1e11 ? Math.round(value / 1000) : value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.round(ms / 1000) : 0;
}

async function readAccessToken() {
  const own = await readKeychain(OWN_KEYCHAIN_SERVICE);
  if (own) return own;

  const raw = (await readKeychain(CLAUDE_CODE_KEYCHAIN_SERVICE)) ?? readCredentialsFile();
  if (!raw) throw new Error('no Claude login found; run: node bin/claude-login.mjs');
  let oauth;
  try {
    oauth = JSON.parse(raw).claudeAiOauth;
  } catch {
    throw new Error('Claude login could not be read');
  }
  if (!oauth?.accessToken) throw new Error('Claude login has no subscription token');
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
    throw new Error('Claude Code login has expired; run: node bin/claude-login.mjs');
  }
  return oauth.accessToken;
}

function readKeychain(service) {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { timeout: 5000 },
      (err, stdout) => resolve(err ? null : stdout.trim() || null),
    );
  });
}

function readCredentialsFile() {
  try {
    return fs.readFileSync(CREDENTIALS_FILE, 'utf8');
  } catch {
    return null;
  }
}
