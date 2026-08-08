const sensitiveKeys = /^(api[-_]?key|authorization|secret|ciphertext|authTag)$/i;

function sanitizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => sanitizeUnknown(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) =>
        sensitiveKeys.test(key) ? [] : [[key, sanitizeUnknown(child)]],
      ),
    );
  }
  return value;
}

export function sanitize<T>(value: T): T {
  return sanitizeUnknown(value) as T;
}

export function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof ServiceClientError) return { code: error.code, message: error.safeMessage };
  return { code: 'internal_error', message: 'An internal setup error occurred' };
}

export class ServiceClientError extends Error {
  constructor(
    public readonly code:
      | 'unreachable'
      | 'unauthorized'
      | 'timeout'
      | 'incompatible_response'
      | 'unsupported_version'
      | 'response_too_large'
      | 'not_found'
      | 'non_persistent_tests_disabled'
      | 'seerr_probe_write_disabled'
      | 'configuration_conflict'
      | 'writes_disabled',
    public readonly safeMessage: string,
    public readonly httpStatus?: number,
  ) {
    super(safeMessage);
    this.name = 'ServiceClientError';
  }
}
