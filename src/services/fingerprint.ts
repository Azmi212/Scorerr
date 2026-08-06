import { createHash } from 'node:crypto';

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeValue(child)]),
    );
  }
  return value;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function fingerprintEvent(payload: unknown): string {
  return sha256(JSON.stringify(normalizeValue(payload)));
}
