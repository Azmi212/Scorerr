import { SafeHttpClient, type HttpClientOptions } from './http-client.js';

export class RadarrClient {
  private readonly http: SafeHttpClient;
  constructor(baseUrl: string, apiKey: string, options: HttpClientOptions) {
    this.http = new SafeHttpClient(baseUrl, apiKey, 'X-Api-Key', options);
  }
  status(): Promise<unknown> {
    return this.http.request('GET', '/api/v3/system/status');
  }
  notifications(): Promise<unknown> {
    return this.http.request('GET', '/api/v3/notification');
  }
  notificationSchemas(): Promise<unknown> {
    return this.http.request('GET', '/api/v3/notification/schema');
  }
  createNotification(payload: unknown): Promise<unknown> {
    return this.http.request('POST', '/api/v3/notification', payload);
  }
  testNotification(payload: unknown): Promise<unknown> {
    return this.http.request('POST', '/api/v3/notification/test', payload);
  }
  deleteNotification(id: number): Promise<unknown> {
    return this.http.request('DELETE', `/api/v3/notification/${String(id)}`);
  }
}
