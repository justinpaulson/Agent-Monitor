# Agent Monitor

A small round USB desk display that shows your running Claude Code and Codex
sessions and plan usage, and glows amber when one needs you.

- **Outer ring:** how much of the week's plan allowance is left. It starts
  full and drains.
- **Inner ring:** how much of the 5-hour session allowance is left (only shown
  on plans that have one).
- **Centre:** the most urgent session state and how many sessions are in it.
  Blue = working, amber with a slow glow = needs you, green = done.
- **Swipe left or right:** switch between Claude and Codex. The display jumps
  to an agent by itself when it starts waiting on you.
- **Tap:** step through that agent's sessions one at a time. Each shows time
  spent working, tokens used (not counting cache reads), files changed and
  tool calls.

## Hardware

One ESP32-2424S012C (ESP32-C3, 1.28" round 240×240 touch display, in a case)
and a USB-C data cable. No soldering.

## How it works

```
Claude Code / Codex hooks ──► hooks/notify.sh ─────┐
Claude status line ────────► hooks/statusline.sh ──┼─► daemon (localhost:47800) ──► USB serial ──► display
Codex session files (~/.codex/sessions) ───────────┘
```

- `hooks/notify.sh` forwards each hook's JSON payload to the daemon.
- `daemon/` tracks session state and writes one JSON line to the device on
  every change and every 2 seconds, e.g.
  `{"s":[["c","d","my-repo",340,48200,5,23]],"u":{"c":[3,5],"x":[9,-1]}}`.
- Claude's usage percentages only exist in the status line payload, so
  `hooks/statusline.sh` wraps your status line command: it forwards the
  payload, then runs your original command unchanged. They appear for
  Pro/Max subscribers after the first reply in a session.
- Codex's usage percentages are read from its session files once a minute.
- `firmware/` draws it. With no line for 10 seconds it shows "lost connection".

## Setup

Flash the board (once, with it plugged in):

```bash
cd firmware && pio run -t upload
```

Install the hooks and start the daemon at login:

```bash
node bin/install.mjs
```

Preview the changes first with `--dry-run`; undo with `--uninstall`.

Give the monitor its own Claude login so the usage rings work even when you
only use the Claude desktop app (the status line only reports usage in
terminal sessions):

```bash
node bin/claude-login.mjs
```

It runs `claude setup-token`, then asks you to paste the token into the macOS
Keychain. Remove it again with `--remove`.

Open http://127.0.0.1:47800 for a simulator of the display, with buttons to
fake sessions. It works without the hardware.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_MONITOR_HTTP_PORT` | `47800` | Port the daemon listens on |
| `AGENT_MONITOR_DEVICE` | first `/dev/cu.usbmodem*` | Serial device path |

Daemon log: `~/Library/Logs/agent-monitor.log`.
