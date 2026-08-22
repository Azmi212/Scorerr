import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';

interface MigrationJournal {
  entries: { tag: string }[];
}

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');

function tableExists(sqlite: BetterSqlite3.Database, tableName: string): boolean {
  return (
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) !== undefined
  );
}

function migrationCount(sqlite: BetterSqlite3.Database): number {
  return (
    sqlite.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get() as {
      count: number;
    }
  ).count;
}

describe('Profile migration', () => {
  it('migrates a fresh database through migration 0006', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scorerr-profile-migration-fresh-'));
    const sqlite = new BetterSqlite3(path.join(directory, 'fresh.db'));
    try {
      migrate(drizzle(sqlite), { migrationsFolder });
      expect(migrationCount(sqlite)).toBe(7);
      expect(tableExists(sqlite, 'profiles')).toBe(true);
      expect(tableExists(sqlite, 'profile_rules')).toBe(true);
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('upgrades a Phase 3B database by applying migration 0006 only', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scorerr-profile-migration-upgrade-'));
    const legacyMigrationsFolder = path.join(directory, 'phase-3b-migrations');
    const sqlite = new BetterSqlite3(path.join(directory, 'phase-3b.db'));
    try {
      fs.cpSync(migrationsFolder, legacyMigrationsFolder, { recursive: true });
      fs.rmSync(path.join(legacyMigrationsFolder, '0006_profiles.sql'));
      const journalPath = path.join(legacyMigrationsFolder, 'meta', '_journal.json');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as MigrationJournal;
      journal.entries = journal.entries.filter((entry) => entry.tag !== '0006_profiles');
      fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

      const database = drizzle(sqlite);
      migrate(database, { migrationsFolder: legacyMigrationsFolder });
      expect(migrationCount(sqlite)).toBe(6);
      expect(tableExists(sqlite, 'profiles')).toBe(false);
      expect(tableExists(sqlite, 'profile_rules')).toBe(false);

      migrate(database, { migrationsFolder });
      expect(migrationCount(sqlite)).toBe(7);
      expect(tableExists(sqlite, 'profiles')).toBe(true);
      expect(tableExists(sqlite, 'profile_rules')).toBe(true);
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
