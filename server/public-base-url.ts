const URL_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

export function normalizePublicBaseUrl(value: string, port: number): string {
  const input = value.trim();
  if (!input) throw new Error('PUBLIC_BASE_URL cannot be blank.');

  const hasScheme = URL_SCHEME.test(input);
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? input : `http://${input}`);
  } catch (error) {
    throw new Error(
      `PUBLIC_BASE_URL must be a host or URL, for example http://192.168.1.25:${port}.`,
      { cause: error },
    );
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('PUBLIC_BASE_URL must use http or https.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new Error('PUBLIC_BASE_URL must be an origin without credentials, path, query, or fragment.');
  }

  // A bare LAN host is shorthand for this server's HTTP origin. Explicit URLs
  // remain untouched so reverse proxies on ports 80/443 continue to work.
  if (!hasScheme && !parsed.port) parsed.port = String(port);
  return parsed.toString().replace(/\/$/, '');
}
