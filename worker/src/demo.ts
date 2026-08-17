// The Scoops Empire: a demo company loadable from settings. An ice cream
// truck operation with a fleet, a flavor lab, a crew, and nested route
// planning, so every feature (covers, checklists, comments, blocked cards,
// specialty lanes, two-level nesting) has something real to show.

import { emitMap } from '../../src/core/emit.ts';
import { joinFrontmatter } from '../../src/core/frontmatter.ts';

export interface BoardImport {
  config: string;
  cards: { path: string; text: string }[];
}

export interface ProjectImport {
  name: string;
  /** Exported project id; import maps it to the new id and rewrites refs. */
  id?: string;
  board?: BoardImport;
  children?: ProjectImport[];
  /** Lane for this project's card in its parent board (children only). */
  lane?: string;
}

export interface SpaceImport {
  name: string;
  projects: ProjectImport[];
}

export interface OrgImport {
  version: 1 | 2;
  name?: string;
  theme?: Record<string, unknown>;
  prefs?: Record<string, unknown>;
  keys?: { hash: string; projectId: string; label: string; created: string; revoked: boolean }[];
  shares?: { token: string; projectId: string; label: string; created: string; revoked: boolean; cardId?: string | null }[];
  spaces: SpaceImport[];
}

const D = '2026-08-16';

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function card(fm: Record<string, unknown>, body = ''): { path: string; text: string } {
  const id = String(fm['id']);
  return {
    path: `cards/${id}-${slug(String(fm['title']))}.md`,
    text: joinFrontmatter(emitMap({ ...fm, created: D }), body),
  };
}

const SIX = `botflow: 0
name: NAME
lanes:
  - id: wishlist
  - id: todo
  - id: doing
  - id: blocked
  - id: done
  - id: archive
`;

const HQ: BoardImport = {
  config: SIX.replace('NAME', 'scoops hq'),
  cards: [
    card(
      { id: '001', title: 'Q3 expansion: two new neighborhoods', lane: 'todo', priority: 'p1', labels: ['growth'] },
      '## Description\nPick two neighborhoods for late summer. Riverside has the foot traffic; the college district has the late crowd.\n\n## Checklist\n- [x] pull last summer sales by stop\n- [ ] scout riverside on a saturday\n- [ ] price a second cart permit\n',
    ),
    card(
      { id: '002', title: 'Renew the downtown vending permit', lane: 'todo', blocked: 'city portal is down, again', labels: ['ops'], priority: 'p0' },
      '## Description\nExpires end of month. Portal has been erroring for two days; call the clerk if it is still broken on Monday.\n\n## Log\n- 2026-08-16 dispatch: blocked, portal outage confirmed by the city\n',
    ),
    card(
      { id: '003', title: 'Summer push: wrap the trucks', lane: 'doing', assignee: 'maya', labels: ['marketing'], cover: 'https://picsum.photos/seed/scoops-wrap/900/360' },
      '## Description\nFull vinyl wraps with the new logo. Two quotes in, one pending.\n\n## Attachments\n- [wrap concept](https://picsum.photos/seed/scoops-logo/800/500)\n\n## Comments\n- 2026-08-16 14:02 maya: the pistachio green pops way harder in person\n- 2026-08-16 15:20 dispatch: get the quote from FastSigns before friday\n',
    ),
    card({ id: '004', title: 'Sponsor the food truck festival', lane: 'wishlist', labels: ['marketing'] }),
  ],
};

const FLEET: BoardImport = {
  config: `botflow: 0
name: fleet
lanes:
  - id: wishlist
    name: Wanted
  - id: todo
    name: In prep
  - id: doing
    name: On route
    wip: 3
  - id: blocked
    name: In the shop
  - id: done
    name: Parked
  - id: archive
`,
  cards: [
    card(
      { id: '001', title: 'Sundae Driver', lane: 'doing', assignee: 'marco', labels: ['truck'], cover: 'https://picsum.photos/seed/scoops-truck1/900/360' },
      '## Description\nThe flagship. Handles the riverside loop.\n\n## Checklist\n- [x] morning stock count\n- [x] freezer temp check\n- [ ] cash float\n- [ ] end of day hose-down\n',
    ),
    card(
      { id: '002', title: 'The Cold Front', lane: 'doing', assignee: 'priya', labels: ['truck'], cover: 'https://picsum.photos/seed/scoops-truck2/900/360' },
      '## Checklist\n- [x] morning stock count\n- [ ] freezer temp check\n',
    ),
    card(
      { id: '003', title: 'Waffle Wagon', lane: 'blocked', blocked: 'transmission at Lou’s until thursday', labels: ['truck'] },
      '## Log\n- 2026-08-16 marco: limped it to Lou’s, sounded like a maraca\n',
    ),
    card({ id: '004', title: 'Sprinkle Sprinter', lane: 'todo', labels: ['truck'] }, '## Description\nWeekend-only unit. Needs a deep clean and a compressor look before saturday.\n'),
    card(
      { id: '005', title: 'Vanilla Thunder (used, marketplace find)', lane: 'wishlist', labels: ['truck'] },
      '## Attachments\n- [listing](https://example.com/marketplace/vanilla-thunder)\n\n## Comments\n- 2026-08-16 09:12 dispatch: priced under book, probably a freezer issue\n',
    ),
  ],
};

const ROUTES: BoardImport = {
  config: SIX.replace('NAME', 'routes'),
  cards: [
    card({ id: '001', title: 'Fri: office parks circuit', lane: 'done', assignee: 'priya' }),
    card(
      { id: '002', title: 'Sat: farmers market loop', lane: 'todo', priority: 'p1' },
      '## Description\n8am load-out, market opens 9. Double stock on sorbet, it sold out last week.\n',
    ),
    card({ id: '003', title: 'Sun: stadium pregame', lane: 'todo', deps: ['002'] }, '## Description\nSame load plan as saturday if the market numbers hold.\n'),
  ],
};

const FLAVORS: BoardImport = {
  config: `botflow: 0
name: flavor lab
lanes:
  - id: wishlist
    name: Ideas
  - id: todo
    name: Test batch
  - id: doing
    name: Scaling up
  - id: taste-test
    canonical: doing
    name: Taste test
  - id: blocked
  - id: done
    name: On the menu
  - id: archive
`,
  cards: [
    card({ id: '001', title: 'Mango Sticky Rice', lane: 'done', labels: ['flavor'], cover: 'https://picsum.photos/seed/scoops-mango/900/360' }),
    card({ id: '002', title: 'Blue Raspberry Classic', lane: 'done', labels: ['flavor'] }),
    card(
      { id: '003', title: 'Cereal Milk', lane: 'taste-test', assignee: 'ines', labels: ['flavor'] },
      '## Comments\n- 2026-08-16 11:40 ines: batch three is the one. corn flakes over frosted.\n',
    ),
    card(
      { id: '004', title: 'Salted Honeycomb', lane: 'doing', assignee: 'ines', labels: ['flavor'] },
      '## Checklist\n- [x] small batch\n- [x] cost per scoop under target\n- [ ] 40L scale test\n',
    ),
    card({ id: '005', title: 'Durian Surprise', lane: 'todo', blocked: 'vendor permit question for imported fruit', labels: ['flavor'] }),
    card({ id: '006', title: 'Pickle Swirl', lane: 'wishlist', labels: ['flavor', 'chaos'] }),
  ],
};

const CREW: BoardImport = {
  config: SIX.replace('NAME', 'crew'),
  cards: [
    card({ id: '001', title: 'Marco, driver (Sundae Driver)', lane: 'done', labels: ['staff'] }),
    card(
      { id: '002', title: 'Ines, flavor chef', lane: 'doing', labels: ['staff'] },
      '## Checklist\n- [x] food handler cert\n- [x] kitchen keys\n- [ ] payroll forms\n',
    ),
    card({ id: '003', title: 'Hire a weekend scooper', lane: 'todo', priority: 'p1', labels: ['hiring'] }, '## Description\nSaturdays are two-truck days now. One more pair of hands or the market line gets ugly.\n'),
    card({ id: '004', title: 'Payroll setup', lane: 'done', labels: ['ops'] }),
  ],
};

export const DEMO: OrgImport = {
  version: 1,
  spaces: [
    {
      name: 'scoops empire',
      projects: [
        {
          name: 'scoops hq',
          board: HQ,
          children: [
            { name: 'fleet', board: FLEET, lane: 'doing', children: [{ name: 'routes', board: ROUTES, lane: 'doing' }] },
            { name: 'flavor lab', board: FLAVORS, lane: 'doing' },
            { name: 'crew', board: CREW, lane: 'doing' },
          ],
        },
      ],
    },
  ],
};
