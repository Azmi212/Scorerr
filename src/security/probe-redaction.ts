const sensitiveName =
  /api[-_]?key|password|passkey|secret|token|authkey|authorization|credential|username|headers?|cookies?/i;

export interface RedactedProbeData {
  value: unknown;
  sensitiveFields: string[];
}

function redactUrl(value: string, path: string, detected: Set<string>): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return value;
    if (url.username || url.password) {
      detected.add(`${path}:url-credentials`);
      url.username = url.username ? '[REDACTED]' : '';
      url.password = url.password ? '[REDACTED]' : '';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveName.test(key)) {
        detected.add(`${path}:query:${key}`);
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString().replaceAll('%5BREDACTED%5D', '[REDACTED]');
  } catch {
    return value;
  }
}

function visit(value: unknown, path: string, detected: Set<string>): unknown {
  if (Array.isArray(value))
    return value.map((item, index) => visit(item, `${path}[${String(index)}]`, detected));
  if (typeof value === 'string') return redactUrl(value, path, detected);
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const descriptorName = typeof record.name === 'string' ? record.name : undefined;
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => {
      const childPath = path ? `${path}.${key}` : key;
      if (
        sensitiveName.test(key) ||
        (key === 'value' && descriptorName && sensitiveName.test(descriptorName))
      ) {
        detected.add(
          descriptorName && key === 'value' ? `${childPath} (${descriptorName})` : childPath,
        );
        return [key, '[REDACTED]'];
      }
      return [key, visit(child, childPath, detected)];
    }),
  );
}

export function redactProbeData(value: unknown): RedactedProbeData {
  const detected = new Set<string>();
  return { value: visit(value, '', detected), sensitiveFields: [...detected].sort() };
}
