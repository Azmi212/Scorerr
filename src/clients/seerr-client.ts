import { SafeHttpClient, type HttpClientOptions } from './http-client.js';

export class SeerrClient {
  private readonly http: SafeHttpClient;
  constructor(baseUrl: string, apiKey: string, options: HttpClientOptions) {
    this.http = new SafeHttpClient(baseUrl, apiKey, 'X-Api-Key', options);
  }
  radarrSettings(): Promise<unknown> {
    return this.http.request('GET', '/api/v1/settings/radarr');
  }
  publicSettings(): Promise<unknown> {
    return this.http.request('GET', '/api/v1/settings/public');
  }
  updateRadarr(id: number, payload: unknown): Promise<unknown> {
    return this.http.request('PUT', `/api/v1/settings/radarr/${String(id)}`, payload);
  }
}
