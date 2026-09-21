# Releasing Relay

Relay's source repository can remain private. Public updater artifacts live in
the separate `Eresea/Relay-releases` repository, which must be created as a
public repository with an initial `main` branch.

## One-time GitHub configuration

Create a token that can write releases in `Eresea/Relay-releases`, then add it
to the private Relay repository as the `RELAY_RELEASE_TOKEN` Actions secret.

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
