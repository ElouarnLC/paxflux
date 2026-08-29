import crypto from 'node:crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { CSRF_HEADER_NAME } from '@paxflux/shared';

export function generateCsrfToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, hash };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function verifyCsrfToken(submittedToken: string, storedHash: string): boolean {
  if (!submittedToken || !storedHash) return false;
  const computedHash = hashToken(submittedToken);
  try {
    return crypto.timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch {
    return false;
  }
}

export function validateOriginAndFetchMetadata(req: FastifyRequest): boolean {
  // Check Sec-Fetch-Site if provided
  const secFetchSite = req.headers['sec-fetch-site'];
  if (secFetchSite && secFetchSite === 'cross-site') {
    return false;
  }

  // Check Origin header if present
  const origin = req.headers['origin'];
  const host = req.headers['host'];
  if (origin && host) {
    try {
      const originUrl = new URL(origin as string);
      if (originUrl.host !== host) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}
