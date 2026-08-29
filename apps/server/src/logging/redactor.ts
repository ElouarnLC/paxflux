export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'req.headers["x-setup-token"]',
  '*.password',
  '*.setupToken',
  '*.token',
  '*.secret',
  '*.tokenHash',
  '*.csrfHash',
  '*.csrfToken',
  '*.passwordHash',
  '*.pairUrl',
];

export function sanitizeLogObject(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(sanitizeLogObject);
  }
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (
      lower.includes('password') ||
      lower.includes('token') ||
      lower.includes('secret') ||
      lower.includes('csrf') ||
      lower.includes('cookie')
    ) {
      copy[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      copy[key] = sanitizeLogObject(value);
    } else {
      copy[key] = value;
    }
  }
  return copy;
}
