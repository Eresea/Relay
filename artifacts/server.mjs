import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const token = process.env.ARTIFACTS_ADMIN_TOKEN;
if (!token || token.length < 32) throw new Error('Set ARTIFACTS_ADMIN_TOKEN to a random secret of at least 32 characters');
const dir = resolve(process.env.ARTIFACTS_DATA_DIR || './artifact-data');
mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(resolve(dir, 'artifacts.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, html TEXT NOT NULL, created TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS data (artifact TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (artifact, key));`);
const files = Object.fromEntries(['index.html', 'library.js', 'viewer.html', 'viewer.js'].map(name => [name, readFileSync(resolve(here, name))]));
const maxBody = 2 * 1024 * 1024;
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > maxBody) throw new Error('Request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function authorized(req) {
  const actual = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`) return send(res, 403, { error: 'Origin rejected' });
    if (req.method === 'GET' && path === '/') return send(res, 200, files['index.html'], 'text/html; charset=utf-8');
    if (req.method === 'GET' && ['/library.js', '/viewer.js'].includes(path)) return send(res, 200, files[path.slice(1)], 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && /^\/a\/[a-f0-9]{48}$/.test(path)) return send(res, 200, files['viewer.html'], 'text/html; charset=utf-8');
    if (path === '/api/artifacts') {
      if (!authorized(req)) return send(res, 401, { error: 'Invalid admin token' });
      if (req.method === 'GET') return send(res, 200, db.prepare('SELECT id, name, created FROM artifacts ORDER BY created DESC').all());
      if (req.method === 'POST') {
        const item = await body(req);
        if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200 || typeof item.html !== 'string' || !item.html.trim()) return send(res, 400, { error: 'Name and HTML are required' });
        const id = randomBytes(24).toString('hex');
        db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?)').run(id, item.name.trim(), item.html, new Date().toISOString());
        return send(res, 201, { id });
      }
    }
    const match = path.match(/^\/api\/artifacts\/([a-f0-9]{48})(?:\/(data))?$/);
    if (match) {
      const [, id, data] = match;
      const item = db.prepare('SELECT name, html FROM artifacts WHERE id = ?').get(id);
      if (!item) return send(res, 404, { error: 'Artifact not found' });
      if (!data && req.method === 'GET') return send(res, 200, item);
      if (data && req.method === 'POST') {
        const input = await body(req);
        if (typeof input.key !== 'string' || !input.key || input.key.length > 200 || !['get', 'set', 'delete'].includes(input.action)) return send(res, 400, { error: 'Invalid data request' });
        if (input.action === 'get') { const row = db.prepare('SELECT value FROM data WHERE artifact = ? AND key = ?').get(id, input.key); return send(res, 200, { value: row ? JSON.parse(row.value) : null }); }
        if (input.action === 'delete') db.prepare('DELETE FROM data WHERE artifact = ? AND key = ?').run(id, input.key);
        else { const value = JSON.stringify(input.value); if (value === undefined || value.length > 100000) return send(res, 400, { error: 'Value too large or invalid' }); db.prepare('INSERT INTO data VALUES (?, ?, ?) ON CONFLICT(artifact, key) DO UPDATE SET value = excluded.value').run(id, input.key, value); }
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (error) { send(res, 400, { error: error.message }); }
});
server.listen(Number(process.env.ARTIFACTS_PORT || 8787), process.env.ARTIFACTS_HOST || '127.0.0.1', () => console.log('Artifact host listening'));
