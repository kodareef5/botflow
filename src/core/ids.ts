import { randomInt } from 'node:crypto';

const HASH_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function nextSeqId(existing: string[]): string {
  let max = 0n; // BigInt: ids past 2^53 must not round down into a collision
  let width = 3;
  for (const id of existing) {
    if (!/^[0-9]+$/.test(id)) continue;
    const n = BigInt(id);
    if (n > max) max = n;
    width = Math.max(width, id.length);
  }
  const next = (max + 1n).toString();
  return next.padStart(Math.max(width, 3), '0');
}

export function newHashId(existing: string[]): string {
  const taken = new Set(existing);
  for (;;) {
    let id = '';
    for (let i = 0; i < 6; i++) id += HASH_ALPHABET[randomInt(HASH_ALPHABET.length)];
    if (!taken.has(id)) return id;
  }
}

/** Filename slug from a card title. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug === '' ? 'card' : slug;
}
