#!/usr/bin/env node
// Agent Monitor daemon.
//
// Agent hooks POST their JSON payload to /event?agent=claude|codex, and the
// Claude status line wrapper POSTs its payload to /usage. The daemon keeps a
// list of sessions plus plan usage and pushes both to the device over USB
// serial as one JSON line:
//
//   {"s":[["c","d","my-repo",340,48200,5,23]],"u":{"c":[3,5],"x":[9,-1]}}
//
//   s: sessions, each [agent, state, name, workSeconds, tokens, filesChanged, toolCalls]
//   u: usage percent per agent as [week, 5-hour session]; -1 = not available
//
//   GET  /        on-screen simulator of the device
//   GET  /state   current state as JSON
//   POST /event   hook payload (see hooks/notify.sh)
//   POST /usage   status line payload (see hooks/statusline.sh)

import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SessionStore } from './state.mjs';
import { UsageStore, fromClaudeStatusline, readCodexUsage } from './usage.mjs';
import { fetchClaudeUsage } from './claude-usage.mjs';
import { readTokens } from './tokens.mjs';
import { SerialLink } from './serial.mjs';

const PORT = Number(process.env.AGENT_MONITOR_HTTP_PORT || 47800);
const HEARTBEAT_MS = 2000;
const CODEX_USAGE_POLL_MS = 60 * 1000;
const CLAUDE_USAGE_POLL_MS = 2 * 60 * 1000;
const CLAUDE_USAGE_MIN_GAP_MS = 30 * 1000;
const CLAUDE_USAGE_BACKOFF_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const SIM_PAGE = fileURLToPath(new URL('./sim.html', import.meta.url));

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const sessions = new SessionStore();
const usage = new UsageStore();
const serial = new SerialLink({ log });

const wire = () => ({ s: sessions.wire(), u: usage.wire() });
const wireLine = () => JSON.stringify(wire()) + '\n';
const push = () => serial.write(wireLine());

let codexUsagePinned = false;
function refreshCodexUsage() {
  if (codexUsagePinned) return;
  if (usage.set('codex', readCodexUsage())) {
    log(`codex usage -> ${JSON.stringify(usage.wire().x)}`);
    push();
  }
}

// Token totals come from the agent's transcript, which is only settled once a
// turn ends, so they are refreshed then (and once when a session first appears).
const TOKEN_EVENTS = new Set(['Stop', 'Interrupt', 'agent-turn-complete']);
async function refreshTokens(key) {
  const session = sessions.get(key);
  if (!session) return;
  const tokens = await readTokens(session);
  if (tokens !== null && sessions.setTokens(key, tokens)) push();
}

// Claude usage is asked from Anthropic on a timer and after each finished turn.
// AGENT_MONITOR_CLAUDE_USAGE=off disables it (the status line still works).
const claudeUsageEnabled = process.env.AGENT_MONITOR_CLAUDE_USAGE !== 'off';
let claudeUsagePinned = false;
let claudeUsageNextAt = 0;
let claudeUsageLastError = null;
async function refreshClaudeUsage() {
  if (!claudeUsageEnabled || claudeUsagePinned || Date.now() < claudeUsageNextAt) return;
  claudeUsageNextAt = Date.now() + CLAUDE_USAGE_MIN_GAP_MS;
  try {
    const windows = await fetchClaudeUsage();
    if (claudeUsageLastError) log('claude usage: working again');
    claudeUsageLastError = null;
    if (usage.set('claude', windows)) {
      log(`claude usage -> ${JSON.stringify(usage.wire().c)}`);
      push();
    }
  } catch (err) {
    // Log each distinct problem once, and ease off when Anthropic says no.
    if (err.message !== claudeUsageLastError) log(`claude usage unavailable: ${err.message}`);
    claudeUsageLastError = err.message;
    if (err.status === 401 || err.status === 403 || err.status === 429) {
      claudeUsageNextAt = Date.now() + CLAUDE_USAGE_BACKOFF_MS;
    }
  }
}

serial.onConnect = push;
setInterval(() => {
  sessions.sweep();
  push();
}, HEARTBEAT_MS);
setInterval(refreshCodexUsage, CODEX_USAGE_POLL_MS);
refreshCodexUsage();
setInterval(refreshClaudeUsage, CLAUDE_USAGE_POLL_MS);
refreshClaudeUsage();

function readJson(req, res, handle) {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) req.destroy();
    else chunks.push(chunk);
  });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400).end('invalid JSON\n');
      return;
    }
    handle(body);
    res.writeHead(204).end();
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const agent = url.searchParams.get('agent') === 'codex' ? 'codex' : 'claude';

  if (req.method === 'POST' && url.pathname === '/event') {
    readJson(req, res, (event) => {
      const key = `${agent}:${event.session_id}`;
      const known = Boolean(sessions.get(key));
      const type = event.hook_event_name || event.type;
      if (sessions.apply(agent, event)) {
        log(`${agent} ${type} -> ${JSON.stringify(sessions.wire())}`);
        push();
      }
      if (TOKEN_EVENTS.has(type) || (!known && sessions.get(key))) refreshTokens(key);
      // Codex writes fresh usage numbers as a turn progresses.
      if (agent === 'codex') refreshCodexUsage();
      else if (TOKEN_EVENTS.has(type)) refreshClaudeUsage();
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/usage') {
    readJson(req, res, (payload) => {
      // The simulator's demo button marks its numbers so real ones stop overwriting them.
      if (payload.demo) {
        if (agent === 'codex') codexUsagePinned = true;
        else claudeUsagePinned = true;
      }
      if (usage.set(agent, fromClaudeStatusline(payload))) {
        log(`${agent} usage -> ${JSON.stringify(usage.wire())}`);
        push();
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ device: serial.path, wire: wire(), sessions: sessions.describe(), usage: usage.usage, claudeUsageError: claudeUsageLastError }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(SIM_PAGE).pipe(res);
    return;
  }

  res.writeHead(404).end('not found\n');
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `port ${PORT} is already in use; is the daemon already running?` : err);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  log(`agent-monitor daemon listening on http://127.0.0.1:${PORT}`);
});
