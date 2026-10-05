#!/usr/bin/env node
// licensing/generate-keypair.js
//
// Run this ONCE, by hand, on the machine you (Paul Enterprises, the vendor)
// use to issue licenses. It creates the Ed25519 keypair that backs the
// whole offline hardware-lock scheme:
//
//   - The PRIVATE key signs new license keys. Only generate-license-key.js
//     ever touches it. It must never be committed to source control and
//     must never ship inside the packaged app — anyone who gets it can
//     mint unlimited valid licenses for any machine.
//   - The PUBLIC key verifies signatures. It's baked into validate-key.js
//     as a hardcoded constant and ships inside every copy of the app —
//     that's safe, because a public key can't be used to forge a license.
//
// Usage:
//   node licensing/generate-keypair.js
//
// This refuses to overwrite an existing keypair (re-running it would
// invalidate every license you've already issued, since old keys were
// signed with the old private key and validate-key.js only trusts the
// public key currently embedded in it).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEYS_DIR = path.join(__dirname, 'keys');
const PRIVATE_KEY_PATH = path.join(KEYS_DIR, 'private.pem');
const PUBLIC_KEY_PATH = path.join(KEYS_DIR, 'public.pem');

function main() {
  if (fs.existsSync(PRIVATE_KEY_PATH)) {
    console.error(`A keypair already exists at ${PRIVATE_KEY_PATH}.`);
    console.error('Refusing to overwrite it — doing so would invalidate every license already issued with it.');
    console.error('If you really mean to rotate keys, move/delete the old keypair yourself first, then re-run this script,');
    console.error('and update the PUBLIC_KEY_PEM constant in licensing/validate-key.js with the new public key it prints.');
    process.exit(1);
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

  fs.mkdirSync(KEYS_DIR, { recursive: true });
  fs.writeFileSync(PRIVATE_KEY_PATH, privatePem, { mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY_PATH, publicPem, { mode: 0o644 });

  console.log('New Ed25519 keypair generated.\n');
  console.log(`Private key -> ${PRIVATE_KEY_PATH}  (SECRET — keep this off any machine that isn't strictly yours,`);
  console.log('               never commit it, never let it near the packaged app.)');
  console.log(`Public key  -> ${PUBLIC_KEY_PATH}  (safe to share — this is what ships inside the app.)\n`);
  console.log('Next step: copy the PEM below into the PUBLIC_KEY_PEM constant at the top of licensing/validate-key.js\n');
  console.log(publicPem);
}

if (require.main === module) main();

module.exports = { KEYS_DIR, PRIVATE_KEY_PATH, PUBLIC_KEY_PATH };
