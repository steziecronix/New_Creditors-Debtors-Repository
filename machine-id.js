// licensing/machine-id.js
//
// Generates a stable, hardware-derived Machine ID used to hardware-lock
// license keys (Approach A from the design doc — fully offline, no
// activation server; a key is issued for one Machine ID and checked
// locally). The ID must:
//   - stay the same across reboots and app restarts
//   - stay the same if the user renames the PC or changes its network
//   - change if the license file is copied onto a different physical
//     machine (that's the whole point of a hardware lock)
//   - be derivable with zero network access
//
// Primary source per OS (all set once by the OS installer, not by the user):
//   Windows -> HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid
//   macOS   -> IOPlatformUUID (via ioreg)
//   Linux   -> /etc/machine-id, falling back to /var/lib/dbus/machine-id
// The shipped app only ever runs on Windows 10, so the Windows branch is
// the one that matters in production — the macOS/Linux branches exist so
// this module (and its tests) can run on a developer's non-Windows machine
// too.
//
// Fallback (used only if the OS-specific source can't be read — e.g. a
// locked-down machine that blocks `reg query`): hostname + the first
// non-internal network adapter's MAC address + platform + arch. This is
// weaker — a network adapter swap or a hostname change could shift it —
// but keeps the app usable rather than refusing to run at all.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');

let cachedMachineId = null;

// exec/readFile are real by default; tests inject fakes so the whole
// module can be exercised on any OS without actually touching the registry,
// ioreg, or the filesystem's real machine-id file.
function defaultExec(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}
const defaultReadFile = (p) => fs.readFileSync(p, 'utf8');

function readWindowsMachineGuid(exec) {
  const out = exec('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
  const match = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
  if (!match) throw new Error('MachineGuid not found in "reg query" output.');
  return match[1].trim();
}

function readMacPlatformUUID(exec) {
  const out = exec('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
  const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  if (!match) throw new Error('IOPlatformUUID not found in "ioreg" output.');
  return match[1].trim();
}

function readLinuxMachineId(readFile) {
  const candidates = ['/etc/machine-id', '/var/lib/dbus/machine-id'];
  const errors = [];
  for (const p of candidates) {
    try {
      const content = readFile(p).trim();
      if (content) return content;
    } catch (err) {
      errors.push(`${p}: ${err.message}`);
    }
  }
  throw new Error(`No machine-id file found. Tried: ${errors.join('; ')}`);
}

// Hostname + first non-internal MAC + platform/arch. Only reached if the
// OS-specific identifier above couldn't be read.
function readFallbackIdentifier() {
  const nets = os.networkInterfaces();
  let mac = '';
  for (const ifaceList of Object.values(nets)) {
    for (const iface of ifaceList || []) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') { mac = iface.mac; break; }
    }
    if (mac) break;
  }
  return ['fallback', os.hostname(), mac, os.platform(), os.arch()].join('|');
}

// Returns the raw, unhashed hardware identifier for the current platform.
// Exported so tests can exercise every branch (win32/darwin/linux/fallback)
// regardless of which OS the test runner is actually on, by overriding
// `platform`, `exec`, and `readFile`.
function getRawIdentifier({ platform = os.platform(), exec = defaultExec, readFile = defaultReadFile } = {}) {
  try {
    if (platform === 'win32') return 'win32:' + readWindowsMachineGuid(exec);
    if (platform === 'darwin') return 'darwin:' + readMacPlatformUUID(exec);
    if (platform === 'linux') return 'linux:' + readLinuxMachineId(readFile);
  } catch (err) {
    // Don't let a locked-down environment block the app entirely — fall
    // through to the weaker fallback and say why, so a support person
    // looking at logs can see this machine got the less-stable ID.
    console.warn(`[machine-id] Could not read the OS hardware identifier (${err.message}); using the fallback identifier instead.`);
  }
  return readFallbackIdentifier();
}

// Formats a raw identifier into the "XXXX-XXXX-XXXX-XXXX" shape shown in
// Settings and burned into activation keys. SHA-256 first so the raw
// identifier (which may contain a real hardware GUID) is never itself
// displayed or embedded in a license key.
function formatMachineId(rawIdentifier) {
  const hash = crypto.createHash('sha256').update(rawIdentifier).digest('hex').toUpperCase();
  return hash.match(/.{1,4}/g).slice(0, 4).join('-');
}

// Public entry point used by main.js. Cached for the process lifetime —
// the underlying value doesn't change while the app is running, and
// shelling out to `reg query` on every Settings-page render would be
// wasteful. Pass options (platform/exec/readFile) only from tests; any
// call with options bypasses and does not populate the cache, so it never
// contaminates the real result with a fake one.
function getMachineId(options) {
  if (!options && cachedMachineId) return cachedMachineId;
  const id = formatMachineId(getRawIdentifier(options));
  if (!options) cachedMachineId = id;
  return id;
}

// Test-only: clears the cache so a test can force recomputation.
function _resetCacheForTests() {
  cachedMachineId = null;
}

module.exports = { getMachineId, getRawIdentifier, formatMachineId, _resetCacheForTests };
