import { ProblemDetails, CSRF_HEADER_NAME } from '@paxflux/shared';

let csrfTokenInMemory: string | null = null;

export function setCsrfToken(token: string | null) {
  csrfTokenInMemory = token;
}

export function getCsrfToken(): string | null {
  return csrfTokenInMemory;
}

export async function apiFetch<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers || {});

  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
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
    throw problem;
  }

  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return {} as T;
  }

  return response.json() as Promise<T>;
}
