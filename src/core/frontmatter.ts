// Frontmatter framing (SPEC §9): `---\n … \n---\n` at the top of a card file.

export type FrontmatterSplit =
  | { kind: 'ok'; yaml: string; body: string }
  | { kind: 'none' }
  | { kind: 'unclosed' };

export function splitFrontmatter(text: string): FrontmatterSplit {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { kind: 'none' };
  const lines = normalized.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      return {
        kind: 'ok',
        yaml: lines.slice(1, i).join('\n'),
        body: lines.slice(i + 1).join('\n'),
      };
    }
  }
  return { kind: 'unclosed' };
}

/** Re-assemble a card file from frontmatter text and body. */
export function joinFrontmatter(yaml: string, body: string): string {
  const y = yaml.endsWith('\n') ? yaml.slice(0, -1) : yaml;
  return `---\n${y}\n---\n${body}`;
}
