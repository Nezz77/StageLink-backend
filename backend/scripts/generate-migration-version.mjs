import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = fileURLToPath(new URL('../', import.meta.url));
const migrations = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
const version = readdirSync(migrations, { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort().at(-1);
if (!version || !statSync(join(migrations, version, 'migration.sql'), { throwIfNoEntry: false })?.isFile()) {
  throw new Error('The latest Prisma migration must contain a migration.sql file.');
}

function filesUnder(directory, extensions) {
  return readdirSync(join(backend, directory), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && extensions.includes(extname(entry.name)))
    .map(entry => relative(backend, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

const sources = [
  'Dockerfile', 'package.json', 'package-lock.json', 'tsconfig.json', 'prisma.config.ts',
  ...filesUnder('api', ['.ts']),
  ...filesUnder('worker', ['.ts']),
  ...filesUnder('shared', ['.ts']),
  ...filesUnder('prisma', ['.prisma', '.sql', '.toml']),
].sort();
const fingerprint = createHash('sha256');
for (const path of sources) {
  const digest = createHash('sha256').update(readFileSync(join(backend, path))).digest('hex');
  fingerprint.update(JSON.stringify([path, digest]));
}

const generated = fileURLToPath(new URL('../generated/', import.meta.url));
const destination = join(generated, 'migration-version.ts');
const contents = '// Generated from the migrations and Node backend sources for this build.\n'
  + 'export const MIGRATION = ' + JSON.stringify(version) + ';\n'
  + 'export const BUILD_FINGERPRINT = ' + JSON.stringify(fingerprint.digest('hex')) + ';\n';
mkdirSync(generated, { recursive: true });

// Development processes can start together. Readers must always see a complete version file.
if (!statSync(destination, { throwIfNoEntry: false }) || readFileSync(destination, 'utf8') !== contents) {
  const temporary = destination + '.' + process.pid + '.tmp';
  try {
    writeFileSync(temporary, contents);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}
