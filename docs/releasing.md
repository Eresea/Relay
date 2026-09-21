# Releasing Relay

Relay's source repository is public and also hosts the updater artifacts in its
GitHub Releases. The updater feed is served from the `Eresea/Relay` release
assets.

The workflow defaults to `Eresea/Relay`; `RELAY_RELEASE_OWNER` and
`RELAY_RELEASE_NAME` are optional overrides.

## One-time GitHub configuration

Create a token that can write releases in `Eresea/Relay`, then add it to the
Relay repository as the `RELAY_RELEASE_TOKEN` Actions secret.

Add the Tauri signing values as Actions configuration:

- `TAURI_SIGNING_PRIVATE_KEY` — the private key secret
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the optional password secret
- `RELAY_UPDATER_PUBLIC_KEY` — the matching public key repository variable
- `RELAY_UPDATE_ENDPOINT` — optional; defaults to the public repository's
  `latest.json` URL

The private signing key must never be committed. Losing it prevents existing
installed versions from accepting future updates.

## Publishing

Update the matching versions in `package.json`, `src-tauri/tauri.conf.json`,
and `src-tauri/Cargo.toml`, then push a tag such as `v0.2.0`. The release
workflow checks that the versions match, builds Linux and Windows updater
artifacts, signs them, and uploads them to the public release repository.
