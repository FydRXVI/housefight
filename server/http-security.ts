import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export interface HttpSecurityRequest {
  headers: IncomingHttpHeaders;
  socket: { remoteAddress?: string };
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === 'localhost'
    || address === '::1'
    || address?.startsWith('127.') === true
    || address?.startsWith('::ffff:127.') === true;
}

export function isSameOriginRequest(request: Pick<HttpSecurityRequest, 'headers'>): boolean {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export function canUseAdmin(request: HttpSecurityRequest, adminKey: string): boolean {
  if (!isSameOriginRequest(request)) return false;
  if (isLoopbackAddress(request.socket.remoteAddress)) return true;
  const provided = request.headers['x-admin-key'];
  if (!adminKey || typeof provided !== 'string') return false;
  const expectedBytes = Buffer.from(adminKey);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}
