import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const tauriConfig = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
const cargoToml = await readFile('src-tauri/Cargo.toml', 'utf8');
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const versions = {
  'package.json': packageJson.version,
  'src-tauri/tauri.conf.json': tauriConfig.version,
  'src-tauri/Cargo.toml': cargoVersion,
};
const uniqueVersions = new Set(Object.values(versions));
const expectedVersion = process.argv[2];

if (
  uniqueVersions.size !== 1 ||
  [...uniqueVersions][0] === undefined ||
  (expectedVersion !== undefined && packageJson.version !== expectedVersion)
) {
  console.error('Relay version mismatch:', versions);
  if (expectedVersion !== undefined) console.error(`Expected release version ${expectedVersion}`);
  process.exit(1);
}

console.log(`Relay version ${packageJson.version} is consistent`);
