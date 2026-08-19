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

// ---- identity: roles and scopes ----

export type Role = 'owner' | 'write' | 'read';
export type ScopeKind = 'org' | 'space' | 'project';

/** One member's reach: the whole company, one space, or one project subtree. */
export interface Scope {
  kind: ScopeKind;
  /** null exactly when kind is 'org'. */
  id: string | null;
}

/** Where a project sits: its space, plus itself and every ancestor project. */
export interface ProjectLocation {
  spaceId: string;
  ancestorIds: string[];
}

const ROLES: Role[] = ['owner', 'write', 'read'];
const SCOPE_KINDS: ScopeKind[] = ['org', 'space', 'project'];

export function validRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as string[]).includes(value);
}

export function validScopeKind(value: unknown): value is ScopeKind {
  return typeof value === 'string' && (SCOPE_KINDS as string[]).includes(value);
}

/** Usernames are the actor string written into every `## Log` line, so they
 *  must survive a markdown round-trip. The log entry parser splits on the
 *  first ": ", which is why a colon (and whitespace, and uppercase, which
 *  would let two members collide on a case-insensitive read) is out. */
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export function validUsername(value: unknown): value is string {
  return typeof value === 'string' && USERNAME_RE.test(value);
}

/** Role ordering: owner does everything, write also reads, read only reads.
 *  Anything unrecognized is denied rather than defaulted. */
export function roleAllows(role: unknown, need: Role): boolean {
  if (!validRole(role)) return false;
  if (role === 'owner') return true;
  if (role === 'write') return need !== 'owner';
  return need === 'read';
}

/** Does `scope` reach the project described by `at`? Org reaches everything;
 *  a space scope reaches every project in that space (however deeply nested,
 *  because projects never cross spaces); a project scope reaches itself and
 *  its descendants, which is what `ancestorIds` encodes. */
export function scopeAllows(scope: Scope, at: ProjectLocation): boolean {
  if (!validScopeKind(scope.kind)) return false;
  if (scope.kind === 'org') return true;
  if (typeof scope.id !== 'string' || scope.id === '') return false;
  if (scope.kind === 'space') return scope.id === at.spaceId;
  return at.ancestorIds.includes(scope.id);
}

// ---- passwords: PBKDF2-SHA-256 over WebCrypto ----
// crypto.subtle is global in both workerd and Node >= 24, so these run (and
// are tested) without booting a Worker. The iteration count lives inside the
// stored string, so it can be raised later without invalidating old hashes.

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// The ArrayBuffer type argument is load-bearing: this file is typechecked
// under both @cloudflare/workers-types and node's lib, and crypto.subtle
// accepts only an ArrayBuffer-backed view (never a SharedArrayBuffer one).
function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<string> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, KEY_BITS);
  return toHex(new Uint8Array(bits));
}

/** Length-independent equality: compare digests of both sides so a mismatch
 *  in length leaks nothing through timing either. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `pbkdf2$<iterations>$<saltHex>$<hashHex>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(SALT_BYTES)));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${hash}`;
}

/** Fail closed on anything that is not a well-formed stored hash: a corrupt
 *  or empty pass_hash must never authenticate, least of all against "". */
export async function verifyPassword(password: string, stored: unknown): Promise<boolean> {
  if (typeof password !== 'string' || password === '' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return false;
  const salt = fromHex(parts[2]!);
  if (salt === null || parts[3]!.length !== KEY_BITS / 4 || fromHex(parts[3]!) === null) return false;
  return sameSecret(await derive(password, salt, iterations), parts[3]!);
}

let absent: Promise<string> | null = null;

/** A real hash to verify against when the named account does not exist, so an
 *  unknown username costs the same PBKDF2 derivation as a wrong password.
 *  Verifying against '' returns before doing any work, and that difference is
 *  measurable: it turns any login endpoint into a username oracle. */
export function absentPasswordHash(): Promise<string> {
  absent ??= hashPassword('no-such-account-placeholder');
  return absent;
}

/** Minimum password strength. Deliberately length-only: a bot's password is
 *  generated, and composition rules mostly annoy humans into worse choices. */
export function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 200;
}

/** Decode an `Authorization: Basic` value. Returns null on anything malformed
 *  so the caller falls through to "unauthorized" rather than guessing. */
export function parseBasic(header: string): { username: string; password: string } | null {
  if (!header.startsWith('Basic ')) return null;
  let decoded: string;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return null;
  }
  const split = decoded.indexOf(':');
  if (split < 1) return null;
  return { username: decoded.slice(0, split), password: decoded.slice(split + 1) };
}
