// Small, pure security policies kept outside the Worker entry so their
// fail-closed behavior can be tested without booting workerd.

export type SetupAccess = { ok: true } | { ok: false; status: 403 | 503; error: string };

export function setupAccess(hostname: string, configured: string | undefined, supplied: string | undefined): SetupAccess {
  const setupKey = typeof configured === 'string' && configured !== '' ? configured : null;
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  if (setupKey === null && !loopback) {
    return { ok: false, status: 503, error: 'setup is locked: configure the SETUP_KEY Worker secret, then enter it here' };
  }
  if (setupKey !== null && supplied !== setupKey) {
    return { ok: false, status: 403, error: 'this deployment requires a setup key' };
  }
  return { ok: true };
}
