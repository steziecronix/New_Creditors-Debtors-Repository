#!/usr/bin/env node
// licensing/generate-license-key.js
//
// The vendor-side tool that issues license keys. This is what turns a
// customer's Machine ID into a signed key string they can paste into
// Settings > Licensing. It is the ONLY thing that can produce a key
// validate-key.js will accept, because it's the only thing with access to
// the private half of the keypair.
//
// This file is NOT required by main.js and must never ship inside the
// packaged app (see the warning in licensing/keys/README — anyone with
// this script AND the private key can mint unlimited licenses). Run it by
// hand, from a terminal, on your own machine only.
//
// Setup (once): node licensing/generate-keypair.js
// Usage:
//   node licensing/generate-license-key.js --machine-id 7F2A-91C0-3B4D-88EE --customer "Jane's Shop"
//   node licensing/generate-license-key.js --machine-id 7F2A-91C0-3B4D-88EE --customer "Jane's Shop" --expires 2027-08-31
//   node licensing/generate-license-key.js --machine-id 7F2A-91C0-3B4D-88EE --customer "Jane's Shop" --edition pro
//
// Flags:
//   --machine-id   required. The Machine ID shown in the customer's Settings > Licensing screen.
//   --customer     required. Display name only — not cryptographically checked by the validator.
//   --edition      optional. Defaults to "standard".
//   --expires      optional. YYYY-MM-DD. Omit for a perpetual (never-expiring) license.
//   --key          optional. Path to the private key PEM. Defaults to licensing/keys/private.pem.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const DEFAULT_PRIVATE_KEY_PATH = path.join(__dirname, 'keys', 'private.pem');
const MACHINE_ID_SHAPE = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/i;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Signs a new license key. Pure function — takes the private key PEM as a
 * parameter rather than reading it from disk, so tests can pass in a
 * throwaway test keypair instead of touching the real one.
 *
 * @param {object} args
 * @param {string} args.machineId    - Required. Must look like XXXX-XXXX-XXXX-XXXX.
 * @param {string} args.customer     - Required. Display name, stored in the payload as-is.
 * @param {string} [args.edition]    - Defaults to "standard".
 * @param {string|null} [args.expiresOn] - "YYYY-MM-DD", or null/omitted for a perpetual license.
 * @param {Date}   [args.issuedOn]   - Defaults to now (tests only, otherwise leave it).
 * @param {string} args.privateKeyPem - The vendor's private key PEM.
 * @returns {string} The finished key string, e.g. "PEPOS1-<payload>.<signature>".
 */
function generateLicenseKey({ machineId, customer, edition = 'standard', expiresOn = null, issuedOn = new Date(), privateKeyPem }) {
  if (!machineId || !MACHINE_ID_SHAPE.test(machineId.trim())) {
    throw new Error(`--machine-id must look like XXXX-XXXX-XXXX-XXXX (got: ${machineId})`);
  }
  if (!customer || !customer.trim()) {
    throw new Error('--customer is required (whose license is this?).');
  }
  if (expiresOn && !DATE_SHAPE.test(expiresOn)) {
    throw new Error(`--expires must look like YYYY-MM-DD (got: ${expiresOn})`);
  }
  if (!privateKeyPem) {
    throw new Error('No private key provided.');
  }

  const payload = {
    v: SCHEMA_VERSION,
    m: machineId.trim().toUpperCase(),
    cust: customer.trim(),
    ed: edition,
    iat: issuedOn.toISOString().slice(0, 10),
    exp: expiresOn || null,
  };

  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(payloadSegment), privateKey);
  const signatureSegment = signature.toString('base64url');

  return `PEPOS${SCHEMA_VERSION}-${payloadSegment}.${signatureSegment}`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = value;
    }
  }
  return args;
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args['machine-id'] && !args.customer)) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 22).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(args.help ? 0 : 1);
  }

  const keyPath = args.key || DEFAULT_PRIVATE_KEY_PATH;
  if (!fs.existsSync(keyPath)) {
    console.error(`No private key found at ${keyPath}.`);
    console.error('Run "node licensing/generate-keypair.js" once to create one, then try again.');
    process.exit(1);
  }
  const privateKeyPem = fs.readFileSync(keyPath, 'utf8');

  try {
    const key = generateLicenseKey({
      machineId: args['machine-id'],
      customer: args.customer,
      edition: args.edition,
      expiresOn: args.expires || null,
      privateKeyPem,
    });
    console.log('\nLicense key (send this to the customer to paste into Settings > Licensing):\n');
    console.log(key);
    console.log('');
  } catch (err) {
    console.error('Could not generate a license key: ' + err.message);
    process.exit(1);
  }
}

if (require.main === module) runCli();

module.exports = { generateLicenseKey };
