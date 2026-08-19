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

// ---- outbound fetch policy (link unfurling) ----
// Unfurling lets any write-role member make this worker issue a request to an
// address of their choosing, which is server-side request forgery by
// construction. These are the guards, kept pure so the refusals can be tested
// exhaustively without booting workerd.

export const MAX_UNFURL_BYTES = 512 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const UNFURL_TIMEOUT_MS = 5_000;
export const MAX_REDIRECTS = 3;
const MAX_URL_LENGTH = 2048;

export type UnfurlTarget = { ok: true; url: URL } | { ok: false; reason: string };

/** Expand an IPv6 literal to its eight 16-bit groups, or null if malformed. */
function ipv6Groups(text: string): number[] | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const piece of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const gap = 8 - head.length - tail.length;
  if (gap < 1) return null;
  return [...head, ...Array<number>(gap).fill(0), ...tail];
}

/** Ranges that must never be reachable from an unfurl: loopback, the private
 *  blocks, carrier-grade NAT, and link-local, which carries the cloud instance
 *  metadata endpoint (169.254.169.254) that makes SSRF worth attempting. */
function privateIpv4(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function blockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true;
  // Names that only resolve inside a network, so nothing public can own them.
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const parts = v4.slice(1, 5).map(Number);
    if (parts.some((n) => n > 255)) return true;
    return privateIpv4(parts[0]!, parts[1]!);
  }

  if (host.startsWith('[') && host.endsWith(']')) {
    const groups = ipv6Groups(host.slice(1, -1));
    if (groups === null) return true;
    const [g0, , , , g4, g5, g6, g7] = groups;
    if (groups.every((g) => g === 0)) return true;                    // ::
    if (groups.slice(0, 7).every((g) => g === 0) && g7 === 1) return true; // ::1
    // ::ffff:a.b.c.d — the parser stores these in hex, so decode and re-judge.
    if (g4 === 0 && g5 === 0xffff) return privateIpv4(g6! >> 8, g6! & 0xff);
    if ((g0! & 0xfe00) === 0xfc00) return true;                       // fc00::/7 unique-local
    if ((g0! & 0xffc0) === 0xfe80) return true;                       // fe80::/10 link-local
    return false;
  }
  return false;
}

/** Judge a url this deployment is being asked to fetch. `allowPrivate` exists
 *  only so the test suite can point the worker at a loopback fixture server;
 *  it is never set on a real deployment. */
export function unfurlTarget(raw: unknown, allowPrivate = false): UnfurlTarget {
  if (typeof raw !== 'string' || raw === '') return { ok: false, reason: 'not a url' };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: 'url is too long' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: `${url.protocol} is not fetchable` };
  // Credentials in a url are a way to reach something that is not public, and
  // nothing legitimate needs them for a preview.
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'url carries credentials' };
  if (!allowPrivate && blockedHost(url.hostname)) return { ok: false, reason: 'that address is not publicly routable' };
  return { ok: true, url };
}
