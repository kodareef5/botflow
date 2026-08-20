import { test } from 'node:test';
import assert from 'node:assert/strict';

import { atomFeed, calendarFeed, rssFeed } from '../worker/src/feeds.ts';

const input = {
  projectId: 'p-1',
  title: 'R&D <board>',
  feedUrl: 'https://manager.example/feeds/abc.atom?x=1&y=2',
  generatedAt: '2026-08-20T12:00:00Z',
  events: [{ seq: 7, ts: '2026-08-20T11:00:00Z', actor: 'sam', action: 'comment', card_id: '001', detail: 'ready & waiting <now>' }],
};

test('Atom and RSS feeds escape untrusted board activity and keep stable event ids', () => {
  const atom = atomFeed(input);
  assert.match(atom, /<id>https:\/\/manager\.example\/feeds\/abc\.atom\?x=1&amp;y=2<\/id>/, 'each scoped feed has its own channel identity');
  assert.match(atom, /urn:botflow:p-1:event:7/);
  assert.match(atom, /R&amp;D &lt;board&gt;/);
  assert.match(atom, /ready &amp; waiting &lt;now&gt;/);
  assert.doesNotMatch(atom, /<now>/);

  const rss = rssFeed(input);
  assert.match(rss, /<rss version="2.0">/);
  assert.match(rss, /urn:botflow:p-1:event:7/);
  assert.match(rss, /ready &amp; waiting &lt;now&gt;/);
});

test('iCalendar is CRLF, read-only, due-only, escaped, and UTF-8 folded', () => {
  const ics = calendarFeed({
    projectId: 'p-1',
    title: 'Delivery, calendar',
    generatedAt: '2026-08-20T12:00:00Z',
    cards: [
      { id: '001', title: 'All-day, launch', due: '2026-08-21', lane: 'doing', state: 'doing', updated: null },
      { id: '002', title: 'Timed review', due: '2026-08-22T14:30:00Z', lane: 'todo', state: 'todo', updated: null },
      { id: '003', title: `Very long ${'🚀'.repeat(40)} title`, due: '2026-08-23', lane: 'todo', state: 'todo', updated: null },
    ],
  });
  assert.equal(ics.includes('\n') && !ics.includes('\r\n'), false, 'all line breaks are CRLF');
  assert.match(ics, /DTSTART;VALUE=DATE:20260821\r\nDTEND;VALUE=DATE:20260822/);
  assert.match(ics, /DTSTART:20260822T143000Z/);
  assert.match(ics, /SUMMARY:All-day\\, launch/);
  assert.match(ics, /\r\n /, 'long UTF-8 line is folded with a continuation');
  assert.match(ics, /METHOD:PUBLISH/);
  assert.doesNotMatch(ics, /METHOD:REQUEST/);
});
