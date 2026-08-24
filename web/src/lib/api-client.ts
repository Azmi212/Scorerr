export interface ApiErrorPayload {
  code?: string;
  message?: string;
  details?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, status: number, options: { code?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (options.code !== undefined) this.code = options.code;
    if (options.details !== undefined) this.details = options.details;
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new TypeError('API paths must be relative to the current origin');
  const { body, ...requestOptions } = options;
  const headers = new Headers(options.headers);
  if (body !== undefined && !headers.has('content-type'))
    headers.set('content-type', 'application/json');
  const response = await fetch(path, {
    ...requestOptions,
    credentials: 'same-origin',
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? ((await response.json()) as unknown)
    : await response.text();
  if (!response.ok) {
    const structured =
      typeof payload === 'object' && payload !== null ? (payload as ApiErrorPayload) : undefined;
    const nested = structured?.error;
    const message =
      nested?.message ??
      structured?.message ??
      (typeof payload === 'string' && payload
        ? payload
        : `Request failed with status ${String(response.status)}`);
    const code = nested?.code ?? structured?.code;
    const details = nested?.details ?? structured?.details;
    throw new ApiError(message, response.status, {
      ...(code !== undefined ? { code } : {}),
      ...(details !== undefined ? { details } : {}),
    });
  }
  return payload as T;
}
