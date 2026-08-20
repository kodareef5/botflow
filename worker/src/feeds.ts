// Dependency-free Atom, RSS 2.0, and iCalendar projections. Inputs are
// bounded snapshots from ProjectDO; formatting performs no network access.

export interface ActivityFeedEvent {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  card_id: string | null;
  detail: string;
}

export interface CalendarFeedCard {
  id: string;
  title: string;
  due: string;
  lane: string;
  state: string;
  updated: string | null;
}

export interface ActivityFeedInput {
  projectId: string;
  title: string;
  feedUrl: string;
  events: ActivityFeedEvent[];
  generatedAt?: string;
}

const xml = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const eventTitle = (event: ActivityFeedEvent): string =>
  `${event.actor} ${event.action}${event.card_id === null ? '' : ` on ${event.card_id}`}`;

const validIso = (value: string | undefined, fallback: string): string => {
  if (value === undefined || Number.isNaN(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
};

export function atomFeed(input: ActivityFeedInput): string {
  const generated = validIso(input.generatedAt, new Date().toISOString());
  const updated = validIso(input.events[0]?.ts, generated);
  const entries = input.events.map((event) => `  <entry>
    <id>urn:botflow:${xml(input.projectId)}:event:${event.seq}</id>
    <title>${xml(eventTitle(event))}</title>
    <updated>${xml(validIso(event.ts, generated))}</updated>
    <author><name>${xml(event.actor)}</name></author>
    <category term="${xml(event.action)}" />
    <content type="text">${xml(event.detail)}</content>
  </entry>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${xml(input.feedUrl)}</id>
  <title>${xml(input.title)} activity</title>
  <updated>${xml(updated)}</updated>
  <link rel="self" href="${xml(input.feedUrl)}" />
${entries}${entries === '' ? '' : '\n'}</feed>
`;
}

export function rssFeed(input: ActivityFeedInput): string {
  const generated = validIso(input.generatedAt, new Date().toISOString());
  const items = input.events.map((event) => `    <item>
      <guid isPermaLink="false">urn:botflow:${xml(input.projectId)}:event:${event.seq}</guid>
      <title>${xml(eventTitle(event))}</title>
      <pubDate>${xml(new Date(validIso(event.ts, generated)).toUTCString())}</pubDate>
      <description>${xml(event.detail)}</description>
      <category>${xml(event.action)}</category>
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>${xml(input.title)} activity</title>
    <link>${xml(input.feedUrl)}</link>
    <description>Bounded botflow project activity</description>
    <lastBuildDate>${xml(new Date(generated).toUTCString())}</lastBuildDate>
${items}${items === '' ? '' : '\n'}  </channel>
</rss>
`;
}

const icalText = (value: unknown): string => String(value ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/\r?\n/g, '\\n')
  .replace(/,/g, '\\,')
  .replace(/;/g, '\\;');

function icalTime(value: string): { property: string; value: string; end?: string } | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const start = value.replace(/-/g, '');
    const at = Date.parse(`${value}T00:00:00Z`);
    if (Number.isNaN(at)) return null;
    const end = new Date(at + 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
    return { property: 'DTSTART;VALUE=DATE', value: start, end };
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return { property: 'DTSTART', value: new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') };
}

/** Fold one content line to 75 UTF-8 octets including continuation syntax. */
function foldLine(line: string): string {
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const char of line) {
    const width = new TextEncoder().encode(char).byteLength;
    const limit = chunks.length === 0 ? 75 : 74; // continuation begins with one space
    if (chunk !== '' && bytes + width > limit) {
      chunks.push(chunk);
      chunk = char;
      bytes = width;
    } else {
      chunk += char;
      bytes += width;
    }
  }
  chunks.push(chunk);
  return chunks.map((part, index) => index === 0 ? part : ` ${part}`).join('\r\n');
}

export function calendarFeed(input: {
  projectId: string;
  title: string;
  cards: CalendarFeedCard[];
  generatedAt?: string;
}): string {
  const generated = validIso(input.generatedAt, new Date().toISOString()).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//botflow//read-only due dates//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icalText(input.title)}`,
  ];
  for (const card of input.cards) {
    const due = icalTime(card.due);
    if (due === null) continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${icalText(card.id)}@${icalText(input.projectId)}.botflow`,
      `DTSTAMP:${generated}`,
      `${due.property}:${due.value}`,
      ...(due.end === undefined ? [] : [`DTEND;VALUE=DATE:${due.end}`]),
      `SUMMARY:${icalText(card.title)}`,
      `DESCRIPTION:${icalText(`${card.state} · ${card.lane}`)}`,
      `X-BOTFLOW-CARD-ID:${icalText(card.id)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
