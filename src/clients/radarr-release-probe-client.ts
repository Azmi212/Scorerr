import { SafeHttpClient, type HttpClientOptions } from './http-client.js';

/** GET-only Radarr client for diagnostics and simulation. It exposes no mutation or grab method. */
export class RadarrReleaseProbeClient {
  private readonly http: SafeHttpClient;

  constructor(baseUrl: string, apiKey: string, options: HttpClientOptions) {
    this.http = new SafeHttpClient(baseUrl, apiKey, 'X-Api-Key', options);
  }

  movie(movieId: number): Promise<unknown> {
    return this.http.request('GET', `/api/v3/movie/${String(movieId)}`);
  }

  movies(): Promise<unknown> {
    return this.http.request('GET', '/api/v3/movie');
  }

  releases(movieId: number): Promise<unknown> {
    return this.http.request('GET', `/api/v3/release?movieId=${String(movieId)}`);
  }
}
