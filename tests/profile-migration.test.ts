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

describe('Database migrations through Phase 5', () => {
  it('migrates a fresh database through migration 0007', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scorerr-profile-migration-fresh-'));
    const sqlite = new BetterSqlite3(path.join(directory, 'fresh.db'));
    try {
      migrate(drizzle(sqlite), { migrationsFolder });
      expect(migrationCount(sqlite)).toBe(8);
      expect(tableExists(sqlite, 'profiles')).toBe(true);
      expect(tableExists(sqlite, 'profile_rules')).toBe(true);
      expect(tableExists(sqlite, 'simulations')).toBe(true);
      expect(tableExists(sqlite, 'simulation_releases')).toBe(true);
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('upgrades a Phase 3B database by applying migrations 0006 and 0007', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scorerr-profile-migration-upgrade-'));
    const legacyMigrationsFolder = path.join(directory, 'phase-3b-migrations');
    const sqlite = new BetterSqlite3(path.join(directory, 'phase-3b.db'));
    try {
      fs.cpSync(migrationsFolder, legacyMigrationsFolder, { recursive: true });
      fs.rmSync(path.join(legacyMigrationsFolder, '0006_profiles.sql'));
      fs.rmSync(path.join(legacyMigrationsFolder, '0007_simulations.sql'));
      const journalPath = path.join(legacyMigrationsFolder, 'meta', '_journal.json');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as MigrationJournal;
      journal.entries = journal.entries.filter(
        (entry) => entry.tag !== '0006_profiles' && entry.tag !== '0007_simulations',
      );
      fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

      const database = drizzle(sqlite);
      migrate(database, { migrationsFolder: legacyMigrationsFolder });
      expect(migrationCount(sqlite)).toBe(6);
      expect(tableExists(sqlite, 'profiles')).toBe(false);
      expect(tableExists(sqlite, 'profile_rules')).toBe(false);

      migrate(database, { migrationsFolder });
      expect(migrationCount(sqlite)).toBe(8);
      expect(tableExists(sqlite, 'profiles')).toBe(true);
      expect(tableExists(sqlite, 'profile_rules')).toBe(true);
      expect(tableExists(sqlite, 'simulations')).toBe(true);
      expect(tableExists(sqlite, 'simulation_releases')).toBe(true);
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('upgrades an existing Phase 4B database by applying migration 0007 only', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scorerr-phase-5-migration-upgrade-'));
    const phase4MigrationsFolder = path.join(directory, 'phase-4b-migrations');
    const sqlite = new BetterSqlite3(path.join(directory, 'phase-4b.db'));
    try {
      fs.cpSync(migrationsFolder, phase4MigrationsFolder, { recursive: true });
      fs.rmSync(path.join(phase4MigrationsFolder, '0007_simulations.sql'));
      const journalPath = path.join(phase4MigrationsFolder, 'meta', '_journal.json');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as MigrationJournal;
      journal.entries = journal.entries.filter((entry) => entry.tag !== '0007_simulations');
      fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

      const database = drizzle(sqlite);
      migrate(database, { migrationsFolder: phase4MigrationsFolder });
      expect(migrationCount(sqlite)).toBe(7);
      expect(tableExists(sqlite, 'profiles')).toBe(true);
      expect(tableExists(sqlite, 'simulations')).toBe(false);
      sqlite
        .prepare(
          'INSERT INTO profiles (id, name, description, schema_version, revision, created_at, updated_at) VALUES (1, ?, NULL, 1, 3, 1, 1)',
        )
        .run('Existing profile');
      sqlite
        .prepare(
          'INSERT INTO profile_rules (profile_id, type, position, config_version, config_json, created_at, updated_at) VALUES (1, ?, 0, 1, ?, 1, 1)',
        )
        .run('language', JSON.stringify({ preferredLanguages: ['fr'], fallback: 'original' }));
      const insertConnection = sqlite.prepare(
        `INSERT INTO service_connections
         (service, alias, base_url, secret_ref, is_active, connection_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'connected', 1, 1)`,
      );
      insertConnection.run('radarr', 'sole-active', 'http://radarr-a', 'secret-a', 1);
      insertConnection.run('seerr', 'active-a', 'http://seerr-a', 'secret-b', 1);
      insertConnection.run('seerr', 'active-b', 'http://seerr-b', 'secret-c', 1);
      insertConnection.run('radarr', 'inactive', 'http://radarr-b', 'secret-d', 0);

      migrate(database, { migrationsFolder });
      expect(migrationCount(sqlite)).toBe(8);
      expect(tableExists(sqlite, 'simulations')).toBe(true);
      expect(tableExists(sqlite, 'simulation_releases')).toBe(true);
      const columns = sqlite.prepare('PRAGMA table_info(profiles)').all() as { name: string }[];
      expect(columns.map((column) => column.name)).toContain('is_default');
      expect(
        sqlite.prepare('SELECT revision, is_default FROM profiles WHERE id = 1').get(),
      ).toEqual({
        revision: 3,
        is_default: 0,
      });
      expect(
        sqlite
          .prepare(
            'SELECT service, alias, is_default AS isDefault FROM service_connections ORDER BY service, alias',
          )
          .all(),
      ).toEqual([
        { service: 'radarr', alias: 'inactive', isDefault: 0 },
        { service: 'radarr', alias: 'sole-active', isDefault: 1 },
        { service: 'seerr', alias: 'active-a', isDefault: 0 },
        { service: 'seerr', alias: 'active-b', isDefault: 0 },
      ]);
      expect(() =>
        sqlite
          .prepare(
            `UPDATE service_connections SET is_default = 1
             WHERE service = 'radarr' AND alias = 'inactive'`,
          )
          .run(),
      ).toThrow();
      expect(
        sqlite
          .prepare(
            "SELECT config_version AS configVersion, config_json AS configJson FROM profile_rules WHERE profile_id = 1 AND type = 'language'",
          )
          .get(),
      ).toEqual({
        configVersion: 1,
        configJson: JSON.stringify({ preferredLanguages: ['fr'], fallback: 'original' }),
      });
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
