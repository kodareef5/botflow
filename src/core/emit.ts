// Emitter for the strict YAML subset — the inverse of yaml.ts for the shapes
// botflow writes: flat mappings, nested mappings, and scalar lists.

const PLAIN_INT_RE = /^-?(0|[1-9][0-9]*)$/;

function needsQuote(s: string): boolean {
  if (s === '') return true;
  if (s !== s.trim()) return true;
  if (s.includes('\n') || s.includes('\t')) return true;
  if (/^(true|false|null|~)$/.test(s)) return true;
  if (PLAIN_INT_RE.test(s)) return true; // would reparse as a number
  if (/^[-&*!|>{}[\]'"@`%,# ]/.test(s)) return true;
  if (s.includes(' #')) return true;
  if (s.includes(',') || s.includes('[') || s.includes(']')) return true; // safe inside flow lists
  return false;
}

export function emitScalar(v: string | number | boolean | null): string {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (!needsQuote(v)) return v;
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}

/** Emit a mapping as subset-YAML lines. Lists must contain scalars only. */
export function emitMap(obj: Record<string, unknown>, indent = 0): string {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${pad}${key}: [${value.map((v) => emitScalar(v as string | number | boolean | null)).join(', ')}]`);
    } else if (value !== null && typeof value === 'object') {
      lines.push(`${pad}${key}:`);
      lines.push(emitMap(value as Record<string, unknown>, indent + 2));
    } else {
      lines.push(`${pad}${key}: ${emitScalar(value as string | number | boolean | null)}`);
    }
  }
  return lines.join('\n');
}
