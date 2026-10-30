import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveMigrationsDir } from './init.js';

async function makeLayout(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'runwarden-init-test-'));
}

async function writeManifest(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name }),
    'utf8',
  );
}

async function writeMigrations(dir: string, file: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), 'select 1;', 'utf8');
}

describe('resolveMigrationsDir', () => {
  it('resolves the package migrations from a bundled dist layout', async () => {
    const root = await makeLayout();
    const pkg = path.join(root, 'pkg');
    await writeManifest(pkg, 'runwarden');
    await writeMigrations(path.join(pkg, 'migrations'), '0000_init.sql');
    // A foreign migrations directory where a naive ../../ lookup from
    // dist/ would land; it must never win over the package's own.
    await writeMigrations(path.join(root, 'migrations'), 'foreign.sql');
    const moduleUrl = pathToFileURL(
      path.join(pkg, 'dist', 'init-chunk.js'),
    ).href;
    await expect(resolveMigrationsDir(moduleUrl)).resolves.toBe(
      path.join(pkg, 'migrations'),
    );
  });

  it('resolves the package migrations from the source layout', async () => {
    const root = await makeLayout();
    await writeManifest(root, 'runwarden');
    await writeMigrations(path.join(root, 'migrations'), '0000_init.sql');
    const moduleUrl = pathToFileURL(
      path.join(root, 'src', 'db', 'init.js'),
    ).href;
    await expect(resolveMigrationsDir(moduleUrl)).resolves.toBe(
      path.join(root, 'migrations'),
    );
  });

  it('skips package.json files that belong to other packages', async () => {
    const root = await makeLayout();
    await writeManifest(root, 'runwarden');
    await writeMigrations(path.join(root, 'migrations'), '0000_init.sql');
    const other = path.join(root, 'vendor', 'other');
    await writeManifest(other, 'other-package');
    await writeMigrations(path.join(other, 'migrations'), 'foreign.sql');
    const moduleUrl = pathToFileURL(path.join(other, 'dist', 'x.js')).href;
    await expect(resolveMigrationsDir(moduleUrl)).resolves.toBe(
      path.join(root, 'migrations'),
    );
  });

  it('throws when the package has no migrations directory', async () => {
    const root = await makeLayout();
    await writeManifest(root, 'runwarden');
    const moduleUrl = pathToFileURL(path.join(root, 'dist', 'x.js')).href;
    await expect(resolveMigrationsDir(moduleUrl)).rejects.toThrow(
      /no \.sql migrations found/,
    );
  });

  it('throws when no runwarden package root exists above the module', async () => {
    const root = await makeLayout();
    const moduleUrl = pathToFileURL(
      path.join(root, 'bare', 'dist', 'x.js'),
    ).href;
    await expect(resolveMigrationsDir(moduleUrl)).rejects.toThrow(
      /could not locate the runwarden package root/,
    );
  });
});
