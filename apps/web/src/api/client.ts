import { ProblemDetails, CSRF_HEADER_NAME } from '@paxflux/shared';

let csrfTokenInMemory: string | null = null;

export function setCsrfToken(token: string | null) {
  csrfTokenInMemory = token;
}

export function getCsrfToken(): string | null {
  return csrfTokenInMemory;
}

let unauthorizedHandler: (() => void) | null = null;

/**
 * Opt-in hook for a mounted auth guard (see AuthProvider) to be notified of
 * any 401 response, so it can send the user back to /login. Not set on
 * public routes (login/setup/pairing/counter), where a 401 is handled
 * locally instead.
 */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

export async function apiFetch<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers || {});

  if (options.body != null && !headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const method = (options.method || 'GET').toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (csrfTokenInMemory && !headers.has(CSRF_HEADER_NAME)) {
      headers.set(CSRF_HEADER_NAME, csrfTokenInMemory);
    }
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (!response.ok) {
    let problem: ProblemDetails;
    try {
      problem = await response.json();
    } catch {
      problem = {
        type: 'https://paxflux.org/problems/network-error',
        title: 'Erreur réseau',
        status: response.status,
        code: 'INTERNAL_ERROR',
        detail: `Le serveur a renvoyé le statut HTTP ${response.status}`,
      };
    }
    if (response.status === 401) {
      unauthorizedHandler?.();
    }
    throw problem;
  }

  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return {} as T;
  }

  return response.json() as Promise<T>;
}
