// Structured view of a card's markdown body (SPEC §5): sections, checklists,
// attachments, comments, log. Pure and shared by CLI, MCP, viewer, and DOs -
// the body stays plain markdown; this module is just how tools read/write it.

export interface ChecklistItem {
  text: string;
  checked: boolean;
  /** Global ordinal across the whole body, in order of appearance (0-based). */
  index: number;
}

export interface Checklist {
  /** Section heading the items live under ("Checklist" when unnamed/preamble). */
  section: string;
  items: ChecklistItem[];
}

export interface Attachment {
  label: string;
  url: string;
  /** Ordinal within the Attachments section (0-based). */
  index: number;
}

export interface BodyEntry {
  when: string;
  actor: string;
  text: string;
}

export interface ParsedBody {
  /** Raw markdown of the `## Description` section, or null. */
  description: string | null;
  checklists: Checklist[];
  checklist: { done: number; total: number };
  attachments: Attachment[];
  /** Attachment urls that look like images (gallery + cover fallback). */
  images: string[];
  comments: BodyEntry[];
  boosts: BodyEntry[];
  /** @names derived from Description and Comments, first occurrence wins. */
  mentions: string[];
  log: BodyEntry[];
}

const TASK_RE = /^\s*- \[([ xX])\]\s+(.*)$/;
const LINK_RE = /^-\s+\[(.*?)\]\((\S+?)\)\s*$/;
const ENTRY_RE = /^-\s+(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)\s+(.+?):\s+(.*)$/;
const MENTION_RE = /(?:^|[^A-Za-z0-9_.-])@([A-Za-z0-9][A-Za-z0-9_.-]{0,63})/g;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif)(\?.*)?$|^data:image\//i;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

type Fence = { char: string; len: number } | null;

/** Parse the exact level-two heading marker used by the format without a
 *  backtracking regex. Trailing whitespace is presentation-only. */
function headingName(line: string): string | null {
  return line.startsWith('## ') ? line.slice(3).trimEnd() : null;
}

/** Update fenced-code state after consuming `line`: an opening fence is 3+
 *  backticks or tildes (up to 3 spaces indent); it closes on the same marker
 *  at least as long. Lines inside a fence are literal content: no heading,
 *  task, link, or entry may match there. */
function fenceAfter(line: string, fence: Fence): Fence {
  const m = FENCE_OPEN_RE.exec(line);
  if (!m) return fence;
  const marker = m[1]!;
  if (fence === null) return { char: marker[0]!, len: marker.length };
  return marker[0] === fence.char && marker.length >= fence.len ? null : fence;
}

interface HeadingLine {
  /** Heading text with trailing whitespace stripped. */
  name: string;
  /** Offset of the heading line's first character. */
  start: number;
  /** Offset just past the heading line (its newline). */
  contentStart: number;
}

/** All `## ` heading lines with offsets, fence-aware: a literal `## ` inside
 *  a fenced code block is content, not a section boundary. */
function bodyHeadings(body: string): HeadingLine[] {
  const out: HeadingLine[] = [];
  let fence: Fence = null;
  let i = 0;
  for (;;) {
    const nl = body.indexOf('\n', i);
    const end = nl === -1 ? body.length : nl;
    const line = body.slice(i, end);
    if (fence === null && line.startsWith('## ')) {
      out.push({ name: line.slice(3).replace(/[ \t]+$/, ''), start: i, contentStart: nl === -1 ? end : nl + 1 });
    }
    fence = fenceAfter(line, fence);
    if (nl === -1) break;
    i = nl + 1;
  }
  return out;
}

/** Whether a real (fence-aware) level-two section exists. */
export function bodyHasSection(body: string, name: string): boolean {
  return bodyHeadings(body).some((heading) => heading.name.toLowerCase() === name.toLowerCase());
}

/** Remove one real level-two section and its content. Used when a recurring
 * instance deliberately starts without prior Comments/Boosts/Log history. */
export function removeSection(body: string, name: string): string {
  const headings = bodyHeadings(body);
  const index = headings.findIndex((heading) => heading.name.toLowerCase() === name.toLowerCase());
  if (index === -1) return body;
  const start = headings[index]!.start;
  const end = headings[index + 1]?.start ?? body.length;
  return (body.slice(0, start).trimEnd() + '\n\n' + body.slice(end).trimStart()).trim() + (body.trim() === '' ? '' : '\n');
}

export function parseBody(body: string): ParsedBody {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let section: string | null = null;
  const descLines: string[] = [];
  const checklists = new Map<string, ChecklistItem[]>();
  const attachments: Attachment[] = [];
  const comments: BodyEntry[] = [];
  const boosts: BodyEntry[] = [];
  const mentions: string[] = [];
  const mentionSet = new Set<string>();
  const log: BodyEntry[] = [];
  let taskIndex = 0;
  let fence: Fence = null;

  const collectMentions = (text: string): void => {
    MENTION_RE.lastIndex = 0;
    for (let match = MENTION_RE.exec(text); match !== null; match = MENTION_RE.exec(text)) {
      // A dot is legal inside a name, but prose normally ends a mention with
      // sentence punctuation. Keep alice.smith; drop the trailing full stop.
      const name = match[1]!.replace(/\.+$/, '');
      if (name === '') continue;
      if (!mentionSet.has(name)) {
        mentionSet.add(name);
        mentions.push(name);
      }
    }
  };

  for (const line of lines) {
    const fenced = fence !== null || FENCE_OPEN_RE.test(line);
    fence = fenceAfter(line, fence);
    if (fenced) {
      // Fenced code is literal text; only Description keeps it, as content.
      if (section === 'Description') descLines.push(line);
      continue;
    }
    const heading = headingName(line);
    if (heading !== null) {
      section = heading;
      continue;
    }
    const task = TASK_RE.exec(line);
    if (task) {
      const name = section ?? 'Checklist';
      if (!checklists.has(name)) checklists.set(name, []);
      checklists.get(name)!.push({ text: task[2]!, checked: task[1] !== ' ', index: taskIndex++ });
      continue;
    }
    if (section === 'Description') {
      descLines.push(line);
      collectMentions(line);
      continue;
    }
    if (section === 'Attachments') {
      const link = LINK_RE.exec(line.trim());
      if (link) attachments.push({ label: link[1]! || link[2]!, url: link[2]!, index: attachments.length });
      continue;
    }
    if (section === 'Comments' || section === 'Boosts' || section === 'Log') {
      const entry = ENTRY_RE.exec(line.trim());
      if (entry) {
        const parsed = { when: entry[1]!, actor: entry[2]!, text: entry[3]! };
        if (section === 'Comments') {
          comments.push(parsed);
          collectMentions(parsed.text);
        } else if (section === 'Boosts') boosts.push(parsed);
        else log.push(parsed);
      }
    }
  }

  const items = [...checklists.values()].flat();
  return {
    description: descLines.join('\n').trim() || null,
    checklists: [...checklists.entries()].map(([name, list]) => ({ section: name, items: list })),
    checklist: { done: items.filter((i) => i.checked).length, total: items.length },
    attachments,
    images: attachments.filter((a) => IMAGE_RE.test(a.url)).map((a) => a.url),
    comments,
    boosts,
    mentions,
    log,
  };
}

/** Append a full `- …` line to a `## <name>` section, creating the section at
 *  the end of the body when missing. Append-only sections stay append-only. */
export function appendToSection(body: string, name: string, line: string): string {
  const headings = bodyHeadings(body);
  const me = headings.findIndex((h) => h.name === name);
  if (me === -1) {
    const base = body.trimEnd();
    return (base === '' ? '' : base + '\n\n') + `## ${name}\n${line}\n`;
  }
  const sectionStart = headings[me]!.contentStart;
  const next = headings[me + 1];
  // Keep the blank line ahead of the next heading with the tail, as before.
  const sectionEnd = next === undefined ? body.length : next.start - 1;
  const section = body.slice(sectionStart, sectionEnd).trimEnd();
  const head = body.slice(0, sectionStart);
  const rebuilt = (section === '' ? line : section + '\n' + line) + '\n';
  return head + (head.endsWith('\n') ? '' : '\n') + rebuilt + body.slice(sectionEnd);
}

/** Replace the content of a `## <name>` section wholesale. A missing section
 *  is created ("start" puts it before everything, the Description convention;
 *  "before-log" tucks it ahead of `## Log` so the audit trail stays last).
 *  Empty content removes the section, heading included. */
export function setSection(body: string, name: string, content: string, position: 'start' | 'before-log' | 'end' = 'end'): string {
  const clean = content.replace(/\r\n/g, '\n').trim();
  const headings = bodyHeadings(body);
  const me = headings.findIndex((h) => h.name === name);
  if (me === -1) {
    if (clean === '') return body;
    const block = `## ${name}\n${clean}\n`;
    const base = body.trim();
    if (base === '') return block;
    if (position === 'start') return `${block}\n${base}\n`;
    if (position === 'before-log') {
      const log = headings.find((h) => h.name === 'Log');
      if (log) return body.slice(0, log.start) + block + '\n' + body.slice(log.start);
    }
    return `${base}\n\n${block}`;
  }
  const headingStart = headings[me]!.start;
  const sectionStart = headings[me]!.contentStart;
  const next = headings[me + 1];
  const sectionEnd = next === undefined ? body.length : next.start - 1;
  if (clean === '') {
    return (body.slice(0, headingStart) + body.slice(sectionEnd)).replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  }
  const head = body.slice(0, sectionStart);
  return head + (head.endsWith('\n') ? '' : '\n') + clean + '\n' + body.slice(sectionEnd);
}

/** Set the checked state of the Nth task item (global 0-based ordinal). */
export function setChecklistItem(body: string, index: number, checked: boolean): string | null {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let n = 0;
  let fence: Fence = null;
  for (let i = 0; i < lines.length; i++) {
    const fenced = fence !== null;
    fence = fenceAfter(lines[i]!, fence);
    if (fenced) continue; // a task-looking line inside a fence is content
    const m = TASK_RE.exec(lines[i]!);
    if (!m) continue;
    if (n === index) {
      lines[i] = lines[i]!.replace(/- \[[ xX]\]/, checked ? '- [x]' : '- [ ]');
      return lines.join('\n');
    }
    n++;
  }
  return null;
}

export function addAttachmentLine(body: string, label: string, url: string): string {
  return appendToSection(body, 'Attachments', `- [${label.replace(/[[\]]/g, '')}](${url})`);
}

/** Remove the Nth attachment (0-based, within the Attachments section). */
export function removeAttachmentLine(body: string, index: number): string | null {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let section: string | null = null;
  let n = 0;
  let fence: Fence = null;
  for (let i = 0; i < lines.length; i++) {
    const fenced = fence !== null;
    fence = fenceAfter(lines[i]!, fence);
    if (fenced) continue;
    const heading = headingName(lines[i]!);
    if (heading !== null) {
      section = heading;
      continue;
    }
    if (section === 'Attachments' && LINK_RE.test(lines[i]!.trim())) {
      if (n === index) {
        lines.splice(i, 1);
        return lines.join('\n');
      }
      n++;
    }
  }
  return null;
}
