// Parser for the strict YAML subset defined in SPEC §9. Anything outside the
// subset throws YamlError — the subset is deliberately small and closed.

export class YamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'YamlError';
    this.line = line;
  }
}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

const KEY_RE = /^([A-Za-z0-9_-]+):(.*)$/;
const INT_RE = /^-?(0|[1-9][0-9]*)$/;

interface Tok {
  indent: number;
  content: string;
  line: number;
}

export function parseYaml(text: string): YamlValue {
  const toks = tokenize(text);
  if (toks.length === 0) return {};
  const parser = new Parser(toks);
  const value = parser.parseNode(toks[0]!.indent);
  parser.expectEnd();
  return value;
}

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    const stripped = stripComment(lines[i]!);
    if (stripped.trim() === '') continue;
    if (/^ *\t/.test(stripped)) throw new YamlError('tab indentation is not allowed', line);
    let indent = 0;
    while (indent < stripped.length && stripped[indent] === ' ') indent++;
    out.push({ indent, content: stripped.slice(indent).trimEnd(), line });
  }
  return out;
}

/** Cut a `#` comment, respecting quoted strings. `#` comments only at line start or after whitespace. */
function stripComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === '"') {
      if (ch === '\\') i++;
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") {
        if (line[i + 1] === "'") i++;
        else quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i);
    }
  }
  return line;
}

function isDashItem(content: string): boolean {
  return content === '-' || content.startsWith('- ');
}

function isKeyLine(s: string): boolean {
  const m = KEY_RE.exec(s);
  return m !== null && (m[2] === '' || m[2]!.startsWith(' '));
}

class Parser {
  private i = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }

  expectEnd(): void {
    const t = this.peek();
    if (t) throw new YamlError('unexpected content after document', t.line);
  }

  parseNode(indent: number): YamlValue {
    const t = this.peek();
    if (!t) return null;
    if (t.indent !== indent) throw new YamlError('bad indentation', t.line);
    return isDashItem(t.content) ? this.parseSeq(indent) : this.parseMap(indent, null);
  }

  private parseSeq(indent: number): YamlValue[] {
    const items: YamlValue[] = [];
    for (;;) {
      const t = this.peek();
      if (!t || t.indent !== indent || !isDashItem(t.content)) break;
      const after = t.content === '-' ? '' : t.content.slice(2).trim();
      if (after === '') throw new YamlError('empty sequence items are not supported', t.line);
      if (isKeyLine(after)) {
        items.push(this.parseMap(indent + 2, t));
      } else {
        this.i++;
        items.push(parseScalarOrFlow(after, t.line));
      }
    }
    return items;
  }

  /** When `dashTok` is given, its after-dash content is the map's first entry
   *  (the `- id: x` form); continuation keys sit at `indent` (= dash indent + 2). */
  private parseMap(indent: number, dashTok: Tok | null): { [key: string]: YamlValue } {
    const obj: { [key: string]: YamlValue } = {};
    if (dashTok) {
      const after = dashTok.content.slice(2).trim();
      this.i++;
      this.parseEntry(obj, after, dashTok.line, indent);
    }
    for (;;) {
      const t = this.peek();
      if (!t || t.indent !== indent || isDashItem(t.content)) break;
      this.i++;
      this.parseEntry(obj, t.content, t.line, indent);
    }
    return obj;
  }

  private parseEntry(obj: { [key: string]: YamlValue }, content: string, line: number, indent: number): void {
    const m = KEY_RE.exec(content);
    if (!m) throw new YamlError('expected "key: value"', line);
    const key = m[1]!;
    let rest = m[2]!;
    if (rest !== '' && !rest.startsWith(' ')) throw new YamlError('colon after a key must be followed by a space', line);
    rest = rest.trim();
    if (Object.hasOwn(obj, key)) throw new YamlError(`duplicate key "${key}"`, line);
    if (rest === '') {
      const t = this.peek();
      if (t && t.indent > indent) {
        if (t.indent !== indent + 2) throw new YamlError('child blocks must be indented exactly 2 spaces', t.line);
        obj[key] = this.parseNode(indent + 2);
      } else {
        obj[key] = null;
      }
    } else {
      obj[key] = parseScalarOrFlow(rest, line);
    }
  }
}

function parseScalarOrFlow(s: string, line: number): YamlValue {
  if (s.startsWith('[')) return parseFlowList(s, line);
  return parseScalar(s, line);
}

function parseFlowList(s: string, line: number): YamlValue[] {
  if (!s.endsWith(']')) throw new YamlError('unterminated flow list', line);
  const inner = s.slice(1, -1).trim();
  if (inner === '') return [];
  const parts: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote === '"') {
      cur += ch;
      if (ch === '\\') cur += inner[++i] ?? '';
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      cur += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") {
          cur += "'";
          i++;
        } else quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      parts.push(cur);
      cur = '';
    } else if (ch === '[' || ch === ']' || ch === '{' || ch === '}') {
      throw new YamlError('nested flow collections are not supported', line);
    } else {
      cur += ch;
    }
  }
  if (quote) throw new YamlError('unterminated quote in flow list', line);
  parts.push(cur);
  return parts.map((p) => {
    const item = p.trim();
    if (item === '') throw new YamlError('empty flow list item', line);
    return parseScalar(item, line);
  });
}

function parseScalar(s: string, line: number): YamlValue {
  if (s === '') return null;
  const c0 = s[0]!;
  if (c0 === '"') return parseDoubleQuoted(s, line);
  if (c0 === "'") return parseSingleQuoted(s, line);
  if (c0 === '&' || c0 === '*') throw new YamlError('anchors and aliases are not supported', line);
  if (c0 === '!') throw new YamlError('tags are not supported', line);
  if (c0 === '|' || c0 === '>') throw new YamlError('block scalars are not supported', line);
  if (c0 === '{') throw new YamlError('flow mappings are not supported', line);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (INT_RE.test(s)) return parseInt(s, 10);
  return s;
}

function parseDoubleQuoted(s: string, line: number): string {
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\') {
      const n = s[++i];
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === '"' || n === '\\') out += n;
      else throw new YamlError(`unsupported escape \\${n ?? ''}`, line);
    } else if (ch === '"') {
      if (i !== s.length - 1) throw new YamlError('content after closing quote', line);
      return out;
    } else {
      out += ch;
    }
  }
  throw new YamlError('unterminated double-quoted string', line);
}

function parseSingleQuoted(s: string, line: number): string {
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'") {
      if (s[i + 1] === "'") {
        out += "'";
        i++;
      } else {
        if (i !== s.length - 1) throw new YamlError('content after closing quote', line);
        return out;
      }
    } else {
      out += ch;
    }
  }
  throw new YamlError('unterminated single-quoted string', line);
}
