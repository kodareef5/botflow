// Emitter for the strict YAML subset: the inverse of yaml.ts for the shapes
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

type Scalar = string | number | boolean | null;

function isScalar(v: unknown): v is Scalar {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/** Emit a mapping as subset-YAML lines. Handles nested maps, scalar lists
 *  (flow form), and lists of maps (block form), so preserved unknown keys
 *  of any parseable shape round-trip instead of crashing. */
export function emitMap(obj: Record<string, unknown>, indent = 0): string {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.every(isScalar)) {
        lines.push(`${pad}${key}: [${value.map(emitScalar).join(', ')}]`);
      } else {
        lines.push(`${pad}${key}:`);
        for (const item of value) {
          if (isScalar(item)) {
            lines.push(`${pad}  - ${emitScalar(item)}`);
          } else if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            // `- first: v` with continuation keys two deeper (the parser's shape).
            const innerLines = emitMap(item as Record<string, unknown>, indent + 4).split('\n');
            lines.push(`${pad}  - ${innerLines[0]!.trimStart()}`);
            for (const rest of innerLines.slice(1)) lines.push(rest);
          } else {
            lines.push(`${pad}  - ${emitScalar(JSON.stringify(item))}`);
          }
        }
      }
    } else if (value !== null && typeof value === 'object') {
      lines.push(`${pad}${key}:`);
      lines.push(emitMap(value as Record<string, unknown>, indent + 2));
    } else {
      lines.push(`${pad}${key}: ${emitScalar(value as Scalar)}`);
    }
  }
  return lines.join('\n');
}
