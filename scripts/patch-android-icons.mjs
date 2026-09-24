import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const output = mkdtempSync(join(tmpdir(), 'relay-android-icons-'));

try {
  const result = spawnSync(
    process.execPath,
    [
      resolve('node_modules/@tauri-apps/cli/tauri.js'),
      'icon',
      resolve('src-tauri/icons/icon.png'),
      '--output',
      output,
    ],
    { stdio: 'inherit' },
  );

  if (result.status !== 0) throw new Error('Tauri Android icon generation failed.');

  cpSync(
    join(output, 'android'),
    resolve('src-tauri/gen/android/app/src/main/res'),
    { recursive: true },
  );
} finally {
  rmSync(output, { recursive: true, force: true });
}
