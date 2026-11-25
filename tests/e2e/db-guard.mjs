// Never include the input or URL parser's error: either can expose credentials.
export function assertE2eDatabase(urlString) {
  let url;
  try {
    if (typeof urlString !== 'string') throw new Error();
    url = new URL(urlString);
  } catch {
    throw new Error('E2E_DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgresql:', 'postgresql+asyncpg:', 'postgres:'].includes(url.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !url.port || Number(url.port) === 4250
      || url.pathname !== '/readfine_e2e') {
    throw new Error('E2E_DATABASE_URL must use PostgreSQL on loopback, an explicit port other than 4250, and database readfine_e2e');
  }
}

export function requireE2eDatabaseUrl() {
  const url = process.env.E2E_DATABASE_URL;
  if (!url || !url.trim()) {
    throw new Error('E2E_DATABASE_URL is required; no default database is allowed');
  }
  assertE2eDatabase(url);
  return url;
}
