import { ServiceClientError } from '../security/redaction.js';

export interface HttpClientOptions {
  timeoutMs: number;
  maxResponseBytes: number;
  fetch?: typeof fetch;
}

export function normalizeServiceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid service URL');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Only HTTP and HTTPS URLs are allowed');
  if (url.username || url.password || url.hash)
    throw new Error('Credentials and fragments are not allowed in service URLs');
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

export class SafeHttpClient {
  private readonly fetchImplementation: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly apiKeyHeader: 'X-Api-Key',
    private readonly options: HttpClientOptions,
  ) {
    this.fetchImplementation = options.fetch ?? fetch;
  }

  async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    pathname: string,
    body?: unknown,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.options.timeoutMs);
    try {
      const init: RequestInit = {
        method,
        headers: {
          [this.apiKeyHeader]: this.apiKey,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: controller.signal,
      };
      const response = await this.fetchImplementation(new URL(pathname, `${this.baseUrl}/`), init);
      if (response.status === 401 || response.status === 403)
        throw new ServiceClientError('unauthorized', 'Authentication was rejected');
      if (response.status >= 300 && response.status < 400)
        throw new ServiceClientError('incompatible_response', 'HTTP redirects are not accepted');
      if (!response.ok)
        throw new ServiceClientError(
          'incompatible_response',
          `Service returned HTTP ${String(response.status)}`,
        );
      const declaredLength = Number(response.headers.get('content-length') ?? 0);
      if (declaredLength > this.options.maxResponseBytes)
        throw new ServiceClientError(
          'response_too_large',
          'Service response exceeds the configured limit',
        );
      const text = await response.text();
      if (Buffer.byteLength(text) > this.options.maxResponseBytes)
        throw new ServiceClientError(
          'response_too_large',
          'Service response exceeds the configured limit',
        );
      if (!text) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ServiceClientError('incompatible_response', 'Service returned invalid JSON');
      }
    } catch (error) {
      if (error instanceof ServiceClientError) throw error;
      if (error instanceof Error && error.name === 'AbortError')
        throw new ServiceClientError('timeout', 'Service request timed out');
      throw new ServiceClientError('unreachable', 'Service could not be reached');
    } finally {
      clearTimeout(timeout);
    }
  }
}
