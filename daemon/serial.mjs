// Write-only USB serial link to the device, with no native dependencies.
//
// The board shows up as a /dev/cu.* character device. We open it as a file,
// set the line speed with stty, and write newline-delimited JSON to it.
// Set AGENT_MONITOR_DEVICE to force a specific path (any writable path works,
// which is also how the tests capture output).

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const CANDIDATE_PATTERN = /^cu\.(usbmodem|wchusbserial|usbserial|SLAB_USBtoUART)/;
const RESCAN_MS = 3000;

export class SerialLink {
  constructor({ devicePath = process.env.AGENT_MONITOR_DEVICE, log = () => {} } = {}) {
    this.forcedPath = devicePath || null;
    this.log = log;
    this.fd = null;
    this.path = null;
    this.onConnect = null;
    this.timer = setInterval(() => this.ensureOpen(), RESCAN_MS);
    this.timer.unref?.();
    this.ensureOpen();
  }

  get connected() {
    return this.fd !== null;
  }

  ensureOpen() {
    if (this.fd !== null) {
      if (!fs.existsSync(this.path)) this.close('device removed');
      return;
    }
    const target = this.forcedPath || findDevice();
    if (!target) return;
    try {
      const flags = fs.constants.O_WRONLY | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK | fs.constants.O_APPEND;
      const fd = fs.openSync(target, this.forcedPath ? flags | fs.constants.O_CREAT : flags);
      if (fs.fstatSync(fd).isCharacterDevice()) {
        try {
          execFileSync('stty', ['-f', target, '115200', 'cs8', '-cstopb', '-parenb', 'raw', '-echo', 'clocal']);
        } catch {
          // Native USB serial ignores line settings, so a failure here is harmless.
        }
      }
      this.fd = fd;
      this.path = target;
      this.log(`device connected: ${target}`);
      this.onConnect?.();
    } catch (err) {
      this.log(`could not open ${target}: ${err.code || err.message}`);
    }
  }

  write(line) {
    if (this.fd === null) return false;
    try {
      fs.writeSync(this.fd, line);
      return true;
    } catch (err) {
      if (err.code === 'EAGAIN') return false; // device buffer full; the next heartbeat retries
      this.close(err.code || err.message);
      return false;
    }
  }

  close(reason) {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch {}
    this.log(`device disconnected: ${this.path} (${reason})`);
    this.fd = null;
    this.path = null;
  }
}

function findDevice() {
  try {
    const name = fs.readdirSync('/dev').find((f) => CANDIDATE_PATTERN.test(f));
    return name ? `/dev/${name}` : null;
  } catch {
    return null;
  }
}
