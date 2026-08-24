import { ApiError, apiRequest } from './api-client';

describe('apiRequest', () => {
  it('uses relative URLs and returns typed JSON', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const controller = new AbortController();
    await expect(
      apiRequest<{ status: string }>('/health', { signal: controller.signal }),
    ).resolves.toEqual({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/health',
      expect.objectContaining({ credentials: 'same-origin', signal: controller.signal }),
    );
  });

  it('rejects absolute API paths', async () => {
    await expect(apiRequest('https://example.invalid/api')).rejects.toThrow(TypeError);
    await expect(apiRequest('//example.invalid/api')).rejects.toThrow(TypeError);
  });

  it('normalizes structured non-2xx errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'profile_upgrade_required',
            message: 'Mise à niveau requise',
            details: { rule: 'language' },
          },
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    );
    const error = await apiRequest('/api/example').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'profile_upgrade_required',
      details: { rule: 'language' },
      message: 'Mise à niveau requise',
    });
  });
});
