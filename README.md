# licensing/keys/ — DO NOT SHIP, DO NOT COMMIT

This folder holds the Ed25519 keypair that backs every license key this
app will ever issue or accept.

- **private.pem** — signs new license keys. Anyone who has this file can
  generate a working license for ANY machine, for free, forever. It must:
  - never be committed to git (add `licensing/keys/private.pem` to `.gitignore`)
  - never be included in the electron-builder output (exclude `licensing/keys/**`
    and `licensing/generate-license-key.js` / `generate-keypair.js` from the
    packaged app's `files` list in package.json)
  - live only on the machine(s) you personally use to issue licenses

- **public.pem** — verifies signatures. This one IS safe to ship — it's
  already baked into `licensing/validate-key.js` as the `PUBLIC_KEY_PEM`
  constant, which is what actually goes inside the app. You don't need to
  ship this file itself.

If `private.pem` is ever lost, exposed, or leaked: run
`node licensing/generate-keypair.js` again after moving the old files out
of the way, update `PUBLIC_KEY_PEM` in `validate-key.js` with the new
public key it prints, and ship an app update. Every license issued under
the old key will stop validating — there is no way around that with a
purely offline scheme, since there is no server to push a revocation to.
