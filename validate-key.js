// licensing/validate-key.js
//
// Verifies a license key entered into Settings > Licensing, entirely
// offline (Approach A from the design doc — no activation server, no
// network call of any kind). Pairs with generate-license-key.js, which is
// the ONLY thing that can produce a key this module accepts.
//
// How the scheme works:
//   1. generate-keypair.js (run once, by the vendor) makes an Ed25519
//      keypair. The private half never leaves the vendor's machine and
//      never ships in the app. The public half is safe to ship — it can
//      verify signatures but can't create new ones.
//   2. A customer's app shows its Machine ID (licensing/machine-id.js) in
//      Settings. They send that to the vendor.
//   3. The vendor runs generate-license-key.js with that Machine ID (plus
//      customer name / expiry / edition), which signs a small JSON payload
//      with the private key and prints a key string like:
//        PEPOS1-eyJ2IjoxLCJtIjoiN0YyQS05MUMwLTNCNEQtODhFRSJ9.MEUCIQ...
//      and sends it back to the customer.
//   4. The customer pastes that string into the app. THIS module checks:
//        - the string is well-formed
//        - the signature is genuine (i.e. it really was signed by the
//          vendor's private key, using the public key embedded below)
//        - the payload's machine ID matches THIS machine's ID
//        - the key hasn't expired
//      A key signed for one machine will fail step 3 on any other machine,
//      which is what makes the license hardware-locked.
//
// Key format: "PEPOS<schema-version>-<base64url(JSON payload)>.<base64url(signature)>"
// Payload shape: { v, m: machineId, cust, ed: edition, iat: issueDate, exp: expiryDate|null }

const crypto = require('crypto');

// The vendor's PUBLIC key (from licensing/keys/public.pem after running
// generate-keypair.js). Safe to ship — see the header comment above.
// Regenerating the keypair means updating this constant AND accepting that
// every previously issued license key stops validating.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAqe98n/e4fGow2pIPgf4zJvR810IPZjHE5Dkyb5K3w84=
-----END PUBLIC KEY-----
`;

const KEY_PATTERN = /^PEPOS(\d+)-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const SUPPORTED_SCHEMA_VERSIONS = [1];

let cachedPublicKeyObject = null;
function loadPublicKey(pem) {
  if (pem) return crypto.createPublicKey(pem); // test override — never cached
  if (!cachedPublicKeyObject) cachedPublicKeyObject = crypto.createPublicKey(PUBLIC_KEY_PEM);
  return cachedPublicKeyObject;
}

// Machine IDs are compared case-insensitively and with surrounding
// whitespace trimmed — getMachineId() always emits uppercase hex, but a
// human might have retyped one, or an older/newer format might differ in
// case somewhere down the line.
function normalizeMachineId(id) {
  return String(id || '').trim().toUpperCase();
}

/**
 * Validates a license key string against the current machine's ID.
 *
 * @param {string} keyString - The key as entered/pasted by the user.
 * @param {string} machineId - This machine's ID, from getMachineId().
 * @param {object} [options]
 * @param {Date}   [options.now]          - Clock to check expiry against (tests only; defaults to real time).
 * @param {string} [options.publicKeyPem] - Override public key (tests only; defaults to the embedded vendor key).
 * @returns {{valid: boolean, reason?: string, payload?: object}}
 *   reason is one of: 'empty' | 'malformed' | 'unsupported-schema-version' |
 *   'bad-signature' | 'machine-mismatch' | 'expired'. Omitted when valid.
 */
function validateLicenseKey(keyString, machineId, options = {}) {
  const { now = new Date(), publicKeyPem } = options;

  if (!keyString || typeof keyString !== 'string' || !keyString.trim()) {
    return { valid: false, reason: 'empty' };
  }

  const match = keyString.trim().match(KEY_PATTERN);
  if (!match) {
    return { valid: false, reason: 'malformed' };
  }
  const [, schemaVersionStr, payloadSegment, signatureSegment] = match;
  const schemaVersion = Number(schemaVersionStr);
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion)) {
    return { valid: false, reason: 'unsupported-schema-version' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch (err) {
    return { valid: false, reason: 'malformed' };
  }

  let signature;
  try {
    signature = Buffer.from(signatureSegment, 'base64url');
  } catch (err) {
    return { valid: false, reason: 'malformed' };
  }

  // Verify the signature over the exact payload segment bytes — never over
  // a re-serialized version of the parsed object, since JSON.stringify
  // isn't guaranteed to reproduce the original byte-for-byte and a
  // mismatch there would make even a genuine key fail verification.
  let signatureOk;
  try {
    signatureOk = crypto.verify(null, Buffer.from(payloadSegment), loadPublicKey(publicKeyPem), signature);
  } catch (err) {
    return { valid: false, reason: 'bad-signature' };
  }
  if (!signatureOk) {
    return { valid: false, reason: 'bad-signature' };
  }

  if (normalizeMachineId(payload.m) !== normalizeMachineId(machineId)) {
    return { valid: false, reason: 'machine-mismatch' };
  }

  if (payload.exp) {
    // exp is a "YYYY-MM-DD" date — treat it as valid through the end of
    // that day, not from midnight at its start.
    const expiryEndOfDay = new Date(`${payload.exp}T23:59:59.999`);
    if (now.getTime() > expiryEndOfDay.getTime()) {
      return { valid: false, reason: 'expired', payload };
    }
  }

  return { valid: true, payload };
}

module.exports = { validateLicenseKey, normalizeMachineId, PUBLIC_KEY_PEM };
