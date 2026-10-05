// licensing/test-validate-key.js
//
// Tests validate-key.js together with generate-license-key.js — the two
// only make sense as a pair, so most tests here generate a real key with
// one and check it with the other. Run with:
//   node licensing/test-validate-key.js
//
// A throwaway Ed25519 keypair is generated fresh for this run and injected
// via validateLicenseKey's `publicKeyPem` option — the tests never touch
// licensing/keys/private.pem or the real embedded PUBLIC_KEY_PEM, so
// running this file can't leak the real vendor key and doesn't depend on
// generate-keypair.js having been run.

const crypto = require('crypto');
const assert = require('assert');
const { validateLicenseKey, normalizeMachineId } = require('./validate-key');
const { generateLicenseKey } = require('./generate-license-key');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('  ok -', label); }
  else { fail++; console.log('  FAIL -', label); }
}

// ---- Test fixtures: an isolated keypair, never the real vendor one ----
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const testPrivatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const testPublicPem = publicKey.export({ type: 'spki', format: 'pem' });

const { publicKey: otherPublicKey } = crypto.generateKeyPairSync('ed25519'); // simulates an attacker's own keypair
const otherPublicPem = otherPublicKey.export({ type: 'spki', format: 'pem' });

const MACHINE_A = '7F2A-91C0-3B4D-88EE';
const MACHINE_B = 'AAAA-BBBB-CCCC-DDDD';

console.log('--- Happy path: perpetual license ---');
{
  const key = generateLicenseKey({ machineId: MACHINE_A, customer: "Jane's Shop", privateKeyPem: testPrivatePem });
  check('generateLicenseKey() produces the expected key shape', /^PEPOS1-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key));

  const result = validateLicenseKey(key, MACHINE_A, { publicKeyPem: testPublicPem });
  check('validates as valid for the machine it was issued to', result.valid === true);
  check('payload round-trips the machine ID', result.payload.m === MACHINE_A);
  check('payload round-trips the customer name', result.payload.cust === "Jane's Shop");
  check('edition defaults to "standard" when not specified', result.payload.ed === 'standard');
  check('no --expires means a perpetual license (exp: null)', result.payload.exp === null);
}

console.log('--- Custom edition ---');
{
  const key = generateLicenseKey({ machineId: MACHINE_A, customer: 'Jane', edition: 'pro', privateKeyPem: testPrivatePem });
  const result = validateLicenseKey(key, MACHINE_A, { publicKeyPem: testPublicPem });
  check('custom edition is preserved', result.payload.ed === 'pro');
}

console.log('--- Machine ID mismatch (the actual hardware lock) ---');
{
  const key = generateLicenseKey({ machineId: MACHINE_A, customer: 'Jane', privateKeyPem: testPrivatePem });
  const result = validateLicenseKey(key, MACHINE_B, { publicKeyPem: testPublicPem });
  check('a key issued for machine A is rejected on machine B', result.valid === false && result.reason === 'machine-mismatch');
}

console.log('--- Machine ID comparison is case/whitespace tolerant ---');
{
  const key = generateLicenseKey({ machineId: MACHINE_A, customer: 'Jane', privateKeyPem: testPrivatePem });
  const result = validateLicenseKey(key, `  ${MACHINE_A.toLowerCase()}  `, { publicKeyPem: testPublicPem });
  check('lowercase + padded machine ID still matches', result.valid === true);
  check('normalizeMachineId() uppercases and trims', normalizeMachineId(`  ${MACHINE_A.toLowerCase()} `) === MACHINE_A);
}

console.log('--- Expiry ---');
{
  const key = generateLicenseKey({ machineId: MACHINE_A, customer: 'Jane', expiresOn: '2026-12-31', privateKeyPem: testPrivatePem });

  const beforeExpiry = validateLicenseKey(key, MACHINE_A, { publicKeyPem: testPublicPem, now: new Date('2026-12-31T23:59:00') });
  check('valid right up to the last moment of the expiry day', beforeExpiry.valid === true);

  const afterExpiry = validateLicenseKey(key, MACHINE_A, { publicKeyPem: testPublicPem, now: new Date('2027-01-01T00:00:01') });
  check('invalid the instant the expiry day has passed', afterExpiry.valid === false && afterExpiry.reason === 'expired');
  check('expired result still returns the payload (so the UI can show what expired)', afterExpiry.payload && afterExpiry.payload.exp === '2026-12-31');
}

console.log('--- Tampering is rejected ---');
{
  const key = generateLicenseKey({ machineId: MACHINE_A, customer: 'Jane', privateKeyPem: testPrivatePem });
  const [prefix, rest] = key.split('-');
  const [payloadSeg, sigSeg] = rest.split('.');

  // Flip the machine ID inside the payload without re-signing — simulates
  // someone hand-editing the payload to unlock a different machine.
  const decoded = JSON.parse(Buffer.from(payloadSeg, 'base64url').toString('utf8'));
  decoded.m = MACHINE_B;
  const tamperedPayloadSeg = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
  const tamperedKey = `${prefix}-${tamperedPayloadSeg}.${sigSeg}`;

  const result = validateLicenseKey(tamperedKey, MACHINE_B, { publicKeyPem: testPublicPem });
  check('editing the payload without re-signing breaks the signature (not just a coincidental mismatch)', result.valid === false && result.reason === 'bad-signature');
}

console.log('--- Wrong signer (a forged key from someone else\'s keypair) ---');
{
  // Signed with a DIFFERENT private key than the one validate-key.js trusts.
  const key = generateLicenseKey({ machineId: MACHINE_A, customer: 'Attacker', privateKeyPem: testPrivatePem });
  const result = validateLicenseKey(key, MACHINE_A, { publicKeyPem: otherPublicPem }); // app trusts a different public key
  check('a key valid under one keypair is rejected when the app trusts a different public key', result.valid === false && result.reason === 'bad-signature');
}

console.log('--- Malformed / garbage input ---');
{
  check('empty string', validateLicenseKey('', MACHINE_A, { publicKeyPem: testPublicPem }).reason === 'empty');
  check('null', validateLicenseKey(null, MACHINE_A, { publicKeyPem: testPublicPem }).reason === 'empty');
  check('random text', validateLicenseKey('not-a-license-key', MACHINE_A, { publicKeyPem: testPublicPem }).reason === 'malformed');
  check('missing signature segment', validateLicenseKey('PEPOS1-abc123', MACHINE_A, { publicKeyPem: testPublicPem }).reason === 'malformed');
  check('valid shape but garbage base64/signature', validateLicenseKey('PEPOS1-abc.def', MACHINE_A, { publicKeyPem: testPublicPem }).valid === false);
  check('unsupported schema version is rejected cleanly', validateLicenseKey('PEPOS99-abc.def', MACHINE_A, { publicKeyPem: testPublicPem }).reason === 'unsupported-schema-version');

  // Well-formed base64 that decodes to non-JSON garbage
  const garbagePayload = Buffer.from('not json', 'utf8').toString('base64url');
  const fakeSig = crypto.sign(null, Buffer.from(garbagePayload), privateKey).toString('base64url');
  check('base64 decodes fine but payload isn\'t JSON', validateLicenseKey(`PEPOS1-${garbagePayload}.${fakeSig}`, MACHINE_A, { publicKeyPem: testPublicPem }).reason === 'malformed');
}

console.log('--- generateLicenseKey() input validation ---');
{
  assert.throws(() => generateLicenseKey({ machineId: 'not-a-machine-id', customer: 'Jane', privateKeyPem: testPrivatePem }), /machine-id must look like/);
  check('rejects a malformed machine ID', true);

  assert.throws(() => generateLicenseKey({ machineId: MACHINE_A, customer: '', privateKeyPem: testPrivatePem }), /--customer is required/);
  check('rejects a missing customer name', true);

  assert.throws(() => generateLicenseKey({ machineId: MACHINE_A, customer: 'Jane', expiresOn: '31-12-2026', privateKeyPem: testPrivatePem }), /--expires must look like/);
  check('rejects a malformed expiry date', true);

  assert.throws(() => generateLicenseKey({ machineId: MACHINE_A, customer: 'Jane', privateKeyPem: '' }), /No private key/);
  check('rejects a missing private key', true);
}

console.log('--- Real embedded public key is well-formed (sanity check, no signing) ---');
{
  const { PUBLIC_KEY_PEM } = require('./validate-key');
  let loaded = null;
  try { loaded = crypto.createPublicKey(PUBLIC_KEY_PEM); } catch (err) { /* leave null */ }
  check('the PUBLIC_KEY_PEM baked into validate-key.js parses as a valid Ed25519 public key', !!loaded && loaded.asymmetricKeyType === 'ed25519');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
