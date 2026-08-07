import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { eq, sql } from 'drizzle-orm';

import type { DatabaseContext } from '../database/client.js';
import { encryptedSecrets } from '../database/schema.js';

export interface SecretStore {
  put(value: string, reference?: string): string;
  get(reference: string): string;
  delete(reference: string): void;
}

function decodeConfiguredKey(value: string): Buffer {
  const key = /^[a-f\d]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('SCORERR_MASTER_KEY must encode exactly 32 bytes');
  return key;
}

export class SqliteSecretStore implements SecretStore {
  private readonly key: Buffer;

  constructor(
    private readonly database: DatabaseContext,
    databasePath: string,
    configuredKey?: string,
  ) {
    const keyPath = path.join(path.dirname(path.resolve(databasePath)), 'scorerr-master.key');
    if (configuredKey) this.key = decodeConfiguredKey(configuredKey);
    else if (fs.existsSync(keyPath))
      this.key = decodeConfiguredKey(fs.readFileSync(keyPath, 'utf8').trim());
    else {
      const row = database.db
        .select({ count: sql<number>`count(*)` })
        .from(encryptedSecrets)
        .get();
      if ((row?.count ?? 0) > 0) {
        throw new Error('Secret store key is missing while encrypted secrets already exist');
      }
      this.key = randomBytes(32);
      fs.writeFileSync(keyPath, this.key.toString('base64'), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
    }
  }

  put(value: string, reference = randomUUID()): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const now = new Date();
    this.database.db
      .insert(encryptedSecrets)
      .values({
        id: reference,
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: encryptedSecrets.id,
        set: {
          ciphertext: ciphertext.toString('base64'),
          iv: iv.toString('base64'),
          authTag: cipher.getAuthTag().toString('base64'),
          updatedAt: now,
        },
      })
      .run();
    return reference;
  }

  get(reference: string): string {
    const row = this.database.db
      .select()
      .from(encryptedSecrets)
      .where(eq(encryptedSecrets.id, reference))
      .get();
    if (!row) throw new Error('Secret reference was not found');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(row.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  delete(reference: string): void {
    this.database.db.delete(encryptedSecrets).where(eq(encryptedSecrets.id, reference)).run();
  }
}
