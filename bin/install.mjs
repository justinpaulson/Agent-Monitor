#!/usr/bin/env node
// Installs (or removes) the agent-monitor hooks and background daemon.
//
//   node bin/install.mjs              add hooks + start the daemon at login
//   node bin/install.mjs --dry-run    show what would change, write nothing
//   node bin/install.mjs --uninstall  remove hooks + stop the daemon
//
// Existing hooks are left untouched; each config file is backed up before the
// first change (<file>.agent-monitor.bak).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTIFY = path.join(ROOT, 'hooks', 'notify.sh');
const STATUSLINE = path.join(ROOT, 'hooks', 'statusline.sh');
const SERVER = path.join(ROOT, 'daemon', 'server.mjs');
const LABEL = 'com.agent-monitor.daemon';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(os.homedir(), 'Library', 'Logs', 'agent-monitor.log');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const uninstall = args.has('--uninstall');

const TARGETS = [
  {
    agent: 'claude',
    file: path.join(os.homedir(), '.claude', 'settings.json'),
    events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd'],
  },
  {
    agent: 'codex',
    file: path.join(os.homedir(), '.codex', 'hooks.json'),
    events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd'],
  },
];

// Claude's usage percentages only arrive in the status line payload, so the
// status line command is wrapped: ours forwards the payload, then runs the
// original command unchanged.
const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const shellUnquote = (s) => s.slice(1, -1).replace(/'\\''/g, `'`);

function updateStatusLine(config, touched) {
  const current = config.statusLine?.command;
  const wrapped = typeof current === 'string' && current.startsWith(STATUSLINE);
  if (uninstall) {
    if (!wrapped) return;
    const original = current.slice(STATUSLINE.length).trim();
    if (original) config.statusLine.command = shellUnquote(original);
    else delete config.statusLine;
    touched.push('statusLine');
  } else if (!wrapped) {
    config.statusLine = current
      ? { ...config.statusLine, command: `${STATUSLINE} ${shellQuote(current)}` }
      : { type: 'command', command: STATUSLINE };
    touched.push('statusLine');
  }
}

const isOurs = (group) => (group.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(NOTIFY));

function updateHooks({ agent, file, events }) {
  const dirExists = fs.existsSync(path.dirname(file));
  if (!dirExists) {
    console.log(`- ${agent}: ${path.dirname(file)} not found, skipping`);
    return;
  }
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}';
  const config = JSON.parse(original);
  const hadHooks = 'hooks' in config;
  config.hooks ||= {};
  const touched = [];

  for (const event of Object.keys(config.hooks)) {
    const kept = config.hooks[event].filter((g) => !isOurs(g));
    if (kept.length !== config.hooks[event].length) {
      if (uninstall) touched.push(event);
      if (kept.length) config.hooks[event] = kept;
      else delete config.hooks[event];
    }
  }
  if (!uninstall) {
    for (const event of events) {
      (config.hooks[event] ||= []).push({
        hooks: [{ type: 'command', command: `${NOTIFY} ${agent}`, timeout: 3 }],
      });
      touched.push(event);
    }
  }

  if (agent === 'claude') updateStatusLine(config, touched);
  if (!hadHooks && !Object.keys(config.hooks).length) delete config.hooks;

  const updated = JSON.stringify(config, null, 2) + '\n';
  const verb = uninstall ? 'remove hooks from' : 'add hooks to';
  if (JSON.stringify(JSON.parse(original)) === JSON.stringify(config)) {
    console.log(`- ${agent}: ${file} already up to date`);
    return;
  }
  console.log(`- ${agent}: ${verb} ${file} (${touched.join(', ') || 'none'})`);
  if (dryRun) return;
  const backup = `${file}.agent-monitor.bak`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, updated);
}

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${process.execPath}</string><string>${SERVER}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;
}

function launchctl(...cmd) {
  try {
    execFileSync('launchctl', cmd, { stdio: 'ignore' });
  } catch {
    // bootout fails when the job is not loaded; that is fine.
  }
}

function updateDaemon() {
  if (process.platform !== 'darwin') {
    console.log(`- daemon: auto-start is macOS only; run "node ${SERVER}" yourself`);
    return;
  }
  const domain = `gui/${process.getuid()}`;
  console.log(`- daemon: ${uninstall ? 'remove' : 'install'} ${PLIST}`);
  if (dryRun) return;
  launchctl('bootout', `${domain}/${LABEL}`);
  if (uninstall) {
    fs.rmSync(PLIST, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, plist());
  launchctl('bootstrap', domain, PLIST);
}

console.log(`${dryRun ? '[dry run] ' : ''}${uninstall ? 'Uninstalling' : 'Installing'} agent-monitor`);
if (!dryRun) [NOTIFY, STATUSLINE].forEach((f) => fs.chmodSync(f, 0o755));
TARGETS.forEach(updateHooks);
updateDaemon();
if (!uninstall) console.log('\nOpen http://127.0.0.1:47800 for the on-screen simulator. New agent sessions pick up the hooks.');
