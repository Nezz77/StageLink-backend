import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrations = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
const version = readdirSync(migrations, { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort().at(-1);
if (!version || !statSync(join(migrations, version, 'migration.sql'), { throwIfNoEntry: false })?.isFile()) {
  throw new Error('The latest Prisma migration must contain a migration.sql file.');
}

const generated = fileURLToPath(new URL('../generated/', import.meta.url));
const destination = join(generated, 'migration-version.ts');
const contents = '// Generated from the Prisma migrations for this build.\nexport const MIGRATION = ' + JSON.stringify(version) + ';\n';
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
