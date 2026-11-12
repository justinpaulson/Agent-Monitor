#!/usr/bin/env node
// Gives the monitor its own Claude login so it can show your plan usage even
// when you only use the Claude desktop app.
//
//   node bin/claude-login.mjs            create a token and save it
//   node bin/claude-login.mjs --remove   forget the saved token
//
// The token is made by Claude Code's own `claude setup-token` command and is
// saved in your macOS Keychain. This script never sees it: you paste it
// straight into the Keychain's own prompt.

import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { OWN_KEYCHAIN_SERVICE } from '../daemon/claude-usage.mjs';

const LABEL = 'com.agent-monitor.daemon';
const account = os.userInfo().username;
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { stdio: 'inherit', ...options });

if (process.platform !== 'darwin') {
  console.error('This uses the macOS Keychain and only works on a Mac.');
  process.exit(1);
}

if (process.argv.includes('--remove')) {
  const result = run('security', ['delete-generic-password', '-s', OWN_KEYCHAIN_SERVICE], { stdio: 'ignore' });
  console.log(result.status === 0 ? 'Saved token removed.' : 'No saved token to remove.');
} else {
  console.log('Step 1 of 2: Claude Code will open your browser to sign in, then show a token.\n');
  const setup = run('claude', ['setup-token']);
  if (setup.error) {
    console.error('Could not run "claude setup-token". Install Claude Code, or run that command yourself, then run this again.');
    process.exit(1);
  }
  console.log('\nStep 2 of 2: copy the token shown above, then paste it at the prompt below (twice).');
  console.log('Nothing appears as you paste; that is normal.\n');
  // With -w last and no value, the Keychain tool asks for the secret itself.
  const saved = run('security', ['add-generic-password', '-U', '-s', OWN_KEYCHAIN_SERVICE, '-a', account, '-w']);
  if (saved.status !== 0) {
    console.error('\nThe token was not saved.');
    process.exit(1);
  }
  console.log('\nSaved. The usage rings should fill in within a few seconds.');
}

// Restart the daemon so it picks up the change straight away.
run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' });
