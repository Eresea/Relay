import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const secret = 'test-secret-that-is-at-least-32-characters';
test('imported artifacts have isolated shared data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-artifacts-'));
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['artifacts/server.mjs'], {
    env: {
      ...process.env,
      ARTIFACTS_ADMIN_TOKEN: secret,
      ARTIFACTS_DATA_DIR: dir,
      ARTIFACTS_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('exit', (code) => reject(new Error(`Server exited: ${code}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${base}/api/artifacts`)).status, 401);
    const create = async (name) =>
      (
        await (
          await fetch(`${base}/api/artifacts`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ name, html: '<h1>Hello</h1>' }),
          })
        ).json()
      ).id;
    const first = await create('First');
    const second = await create('Second');
    assert.match(first, /^[a-f0-9]{48}$/);
    const data = async (id, input) =>
      (
        await fetch(`${base}/api/artifacts/${id}/data`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        })
      ).json();
    await data(first, { action: 'set', key: 'tasks', value: ['one'] });
    assert.deepEqual((await data(first, { action: 'get', key: 'tasks' })).value, ['one']);
    assert.equal((await data(second, { action: 'get', key: 'tasks' })).value, null);
    await data(first, { action: 'set', key: 'saved', value: { count: 3 } });
    await data(first, { action: 'delete', key: 'tasks' });
    assert.equal((await data(first, { action: 'get', key: 'tasks' })).value, null);
    assert.equal(
      (
        await fetch(`${base}/api/artifacts`, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://other.example' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal((await fetch(`${base}/a/${first}`)).status, 200);
    assert.deepEqual((await data(first, { action: 'get', key: 'saved' })).value, { count: 3 });
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
