import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './client.js';

describe('apiFetch Content-Type handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not set Content-Type on a bodyless POST', async () => {
    await apiFetch('/api/v1/events/1/start', { method: 'POST' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.has('Content-Type')).toBe(false);
  });

  it('sets Content-Type: application/json on a POST with a JSON body', async () => {
    await apiFetch('/api/v1/events', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test Event', capacity: 10 }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('does not set Content-Type when body is explicitly null', async () => {
    await apiFetch('/api/v1/events/1/close', { method: 'POST', body: null });

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.has('Content-Type')).toBe(false);
  });
});
