# Relay artifacts: first slice

A small standalone host for self-contained HTML files. Import and search at `/`, then open or share the artifact URL. Pin the library URL in Relay under **Modules → Pin a web app**. Relay's pinned webviews have no access to Relay's native APIs.

## Run locally

Requires Node 22.13 or newer with `node:sqlite` (Node 24 recommended). Set a long, random admin token before starting:

```powershell
$env:ARTIFACTS_ADMIN_TOKEN = 'replace-with-a-long-random-secret-at-least-32-characters'
node artifacts/server.mjs
```

Open `http://127.0.0.1:8787`. Data lives in `./artifact-data/artifacts.sqlite`; set `ARTIFACTS_DATA_DIR` to change it. Back up the database and its SQLite WAL files together, or stop the host before copying them. `ARTIFACTS_PORT` and `ARTIFACTS_HOST` configure the listener.

## Hosting

Run the included Dockerfile on the server with a persistent `/data` volume and an `ARTIFACTS_ADMIN_TOKEN` secret. Bind its port to loopback and put it behind an HTTPS reverse proxy on a **dedicated domain or subdomain**, separate from Leaf and Nexus. The proxy must replace `X-Forwarded-Proto` with the actual scheme and preserve `Host`. Do not expose the host directly to the internet without HTTPS. Deployment, DNS and proxy configuration are not performed by this repository.

The library requires the admin token. Artifact links are unguessable bearer links: anyone with a link can view the page and read, change or delete its shared data. Do not use them for secrets or send links to people who should not have that access. This first slice has no link revocation, per-user permissions, deletion or rate limiting. Imported code runs in a sandboxed iframe with no access to the host's origin or Relay, but it can make external network requests and must still be trusted with any data it displays. Serve only on a dedicated origin.

## Artifact API

Inside an imported page, `window.relay.data` provides asynchronous JSON key/value storage shared by everyone using its link:

```js
await relay.data.set('tasks', ['Review budget']);
const tasks = await relay.data.get('tasks'); // null when absent
await relay.data.delete('tasks');
```

Values must be JSON serializable, under 100,000 characters; keys are limited to 200 characters. The backing store is SQLite, but arbitrary SQL is deliberately not exposed. Writes are last-write-wins and do not broadcast changes. Existing browser-local storage is not automatically shared. Single HTML files only: relative assets, AI editing, revisions, and real-time updates are not implemented yet.

Run the focused host test with `node --test artifacts/server.test.mjs`.
