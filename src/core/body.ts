// Structured view of a card's markdown body (SPEC §5): sections, checklists,
// attachments, comments, log. Pure and shared by CLI, MCP, viewer, and DOs —
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
  log: BodyEntry[];
}

const HEADING_RE = /^##\s+(.+?)\s*$/;
const TASK_RE = /^\s*- \[([ xX])\]\s+(.*)$/;
const LINK_RE = /^-\s+\[(.*?)\]\((\S+?)\)\s*$/;
const ENTRY_RE = /^-\s+(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)\s+(.+?):\s+(.*)$/;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif)(\?.*)?$|^data:image\//i;

export function parseBody(body: string): ParsedBody {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let section: string | null = null;
  const descLines: string[] = [];
  const checklists = new Map<string, ChecklistItem[]>();
  const attachments: Attachment[] = [];
  const comments: BodyEntry[] = [];
  const log: BodyEntry[] = [];
  let taskIndex = 0;

  for (const line of lines) {
    const h = HEADING_RE.exec(line);
    if (h) {
      section = h[1]!;
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
      continue;
    }
    if (section === 'Attachments') {
      const link = LINK_RE.exec(line.trim());
      if (link) attachments.push({ label: link[1]! || link[2]!, url: link[2]!, index: attachments.length });
      continue;
    }
    if (section === 'Comments' || section === 'Log') {
      const entry = ENTRY_RE.exec(line.trim());
      if (entry) (section === 'Comments' ? comments : log).push({ when: entry[1]!, actor: entry[2]!, text: entry[3]! });
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
    log,
  };
}

/** Append a full `- …` line to a `## <name>` section, creating the section at
 *  the end of the body when missing. Append-only sections stay append-only. */
export function appendToSection(body: string, name: string, line: string): string {
  const headingRe = new RegExp(`(^|\\n)(## ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*)\\n`);
  const m = headingRe.exec(body);
  if (!m) {
    const base = body.trimEnd();
    return (base === '' ? '' : base + '\n\n') + `## ${name}\n${line}\n`;
  }
  const sectionStart = m.index + m[0].length;
  const nextHeading = body.indexOf('\n## ', sectionStart);
  const sectionEnd = nextHeading === -1 ? body.length : nextHeading;
  const section = body.slice(sectionStart, sectionEnd).trimEnd();
  const rebuilt = (section === '' ? line : section + '\n' + line) + '\n';
  return body.slice(0, sectionStart) + rebuilt + body.slice(sectionEnd);
}

/** Set the checked state of the Nth task item (global 0-based ordinal). */
export function setChecklistItem(body: string, index: number, checked: boolean): string | null {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
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
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING_RE.exec(lines[i]!);
    if (h) {
      section = h[1]!;
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
