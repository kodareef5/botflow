// Five complete visual systems over one semantic UI. Each style owns its
// typography, surfaces, shape, flare, accents, and both density treatments.
// Canonical workflow-state colors stay fixed so status meaning never moves.

export interface Palette {
  page: string;
  surface: string;
  surface2: string;
  ink: string;
  ink2: string;
  muted: string;
  grid: string;
  baseline: string;
  ring: string;
  stWishlist: string;
  stTodo: string;
  stBlocked: string;
  stDoing: string;
  stDone: string;
  stArchive: string;
}

export interface Accent {
  id: string;
  name: string;
  light: { acc: string; accInk: string };
  dark: { acc: string; accInk: string };
}

export interface DensityTokens {
  baseSize: string;
  lineHeight: string;
  headerPad: string;
  sideWidth: string;
  sidePad: string;
  paneHeadPad: string;
  viewPad: string;
  columnWidth: string;
  columnGap: string;
  columnPad: string;
  cardGap: string;
  cardPad: string;
  controlPad: string;
  fieldPad: string;
  artHeight: string;
}

export interface Style {
  id: string;
  name: string;
  blurb: string;
  font: string;
  displayFont: string;
  radiusCard: string;
  radiusCtl: string;
  borderW: string;
  borderStyle: string;
  shadowLight: string;
  shadowDark: string;
  light: Palette;
  dark: Palette;
  accents: Accent[];
  densities: { compact: DensityTokens; relaxed: DensityTokens };
}

// This set was checked as a whole: adjacent strip states remain distinguishable
// under common color-vision simulations, while every state is also text-labeled.
const ST_LIGHT = { stTodo: '#898781', stBlocked: '#d03b3b', stDoing: '#2a78d6', stDone: '#0ca30c' };
const ST_DARK = { stTodo: '#898781', stBlocked: '#d03b3b', stDoing: '#3987e5', stDone: '#0ca30c' };

export const STYLES: Style[] = [
  {
    id: 'harbor',
    name: 'Harbor',
    blurb: 'airy coastal product studio',
    font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    displayFont: '"Avenir Next", "Segoe UI", system-ui, sans-serif',
    radiusCard: '16px',
    radiusCtl: '10px',
    borderW: '1px',
    borderStyle: 'solid',
    shadowLight: '0 10px 30px rgba(35, 84, 91, .10)',
    shadowDark: '0 14px 34px rgba(0, 0, 0, .34)',
    light: {
      page: '#edf5f5', surface: '#ffffff', surface2: '#e1efef', ink: '#112d31', ink2: '#496367', muted: '#586f73',
      grid: '#d1e1e1', baseline: '#a7c1c3', ring: 'rgba(17,45,49,.12)',
      stWishlist: '#b7cccd', stArchive: '#dce8e8', ...ST_LIGHT,
    },
    dark: {
      page: '#061417', surface: '#0c2024', surface2: '#123139', ink: '#eefafb', ink2: '#afcacc', muted: '#728f92',
      grid: '#1f3a3f', baseline: '#365a60', ring: 'rgba(238,250,251,.12)',
      stWishlist: '#365a60', stArchive: '#172f34', ...ST_DARK,
    },
    accents: [
      { id: 'pacific', name: 'Pacific', light: { acc: '#176fe8', accInk: '#ffffff' }, dark: { acc: '#6ca7ff', accInk: '#071b36' } },
      { id: 'kelp', name: 'Kelp', light: { acc: '#087f6d', accInk: '#ffffff' }, dark: { acc: '#4bd0b5', accInk: '#05251f' } },
      { id: 'coral', name: 'Coral', light: { acc: '#c94a36', accInk: '#ffffff' }, dark: { acc: '#ff8a70', accInk: '#35130c' } },
      { id: 'marigold', name: 'Marigold', light: { acc: '#9a5b00', accInk: '#ffffff' }, dark: { acc: '#ffc45a', accInk: '#2d1b00' } },
    ],
    densities: {
      compact: {
        baseSize: '13px', lineHeight: '1.38', headerPad: '9px 13px', sideWidth: '248px', sidePad: '10px',
        paneHeadPad: '9px 13px', viewPad: '10px 13px', columnWidth: '232px', columnGap: '9px', columnPad: '7px',
        cardGap: '5px', cardPad: '6px 8px 7px', controlPad: '3px 9px', fieldPad: '5px 8px', artHeight: '76px',
      },
      relaxed: {
        baseSize: '14.5px', lineHeight: '1.5', headerPad: '14px 20px', sideWidth: '292px', sidePad: '16px',
        paneHeadPad: '14px 20px', viewPad: '18px 20px', columnWidth: '282px', columnGap: '16px', columnPad: '11px',
        cardGap: '9px', cardPad: '9px 12px 10px', controlPad: '6px 13px', fieldPad: '8px 11px', artHeight: '104px',
      },
    },
  },
  {
    id: 'phosphor',
    name: 'Phosphor',
    blurb: 'operator terminal and live telemetry',
    font: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    displayFont: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    radiusCard: '0px',
    radiusCtl: '0px',
    borderW: '1px',
    borderStyle: 'solid',
    shadowLight: 'none',
    shadowDark: 'none',
    light: {
      page: '#e9eee6', surface: '#f8fcf4', surface2: '#dce8d8', ink: '#142019', ink2: '#415149', muted: '#5d6f65',
      grid: '#c9d4c5', baseline: '#9daf99', ring: 'rgba(20,32,25,.16)',
      stWishlist: '#aebda9', stArchive: '#d6e0d2', ...ST_LIGHT,
    },
    dark: {
      page: '#030704', surface: '#071009', surface2: '#0b1a10', ink: '#d8f5dd', ink2: '#9bc7a4', muted: '#64866b',
      grid: '#193020', baseline: '#2a4b31', ring: 'rgba(76,255,136,.16)',
      stWishlist: '#2a4b31', stArchive: '#112619', ...ST_DARK,
    },
    accents: [
      { id: 'green', name: 'Phosphor', light: { acc: '#087832', accInk: '#ffffff' }, dark: { acc: '#4cff88', accInk: '#03230d' } },
      { id: 'amber', name: 'Amber CRT', light: { acc: '#965b00', accInk: '#ffffff' }, dark: { acc: '#ffbd4a', accInk: '#2c1900' } },
      { id: 'cyan', name: 'Cold signal', light: { acc: '#006f82', accInk: '#ffffff' }, dark: { acc: '#54e8ff', accInk: '#00262c' } },
      { id: 'violet', name: 'Ultraviolet', light: { acc: '#6842b8', accInk: '#ffffff' }, dark: { acc: '#b495ff', accInk: '#20123f' } },
    ],
    densities: {
      compact: {
        baseSize: '12px', lineHeight: '1.32', headerPad: '7px 10px', sideWidth: '226px', sidePad: '8px',
        paneHeadPad: '7px 10px', viewPad: '8px 10px', columnWidth: '212px', columnGap: '7px', columnPad: '5px',
        cardGap: '4px', cardPad: '4px 6px 5px', controlPad: '2px 7px', fieldPad: '3px 6px', artHeight: '64px',
      },
      relaxed: {
        baseSize: '13.5px', lineHeight: '1.48', headerPad: '11px 15px', sideWidth: '266px', sidePad: '12px',
        paneHeadPad: '11px 15px', viewPad: '13px 15px', columnWidth: '254px', columnGap: '11px', columnPad: '8px',
        cardGap: '7px', cardPad: '7px 9px 8px', controlPad: '4px 10px', fieldPad: '6px 8px', artHeight: '88px',
      },
    },
  },
  {
    id: 'fieldnotes',
    name: 'Field Notes',
    blurb: 'ink, paper, rules, and margin marks',
    font: '"Iowan Old Style", "Palatino Linotype", Georgia, serif',
    displayFont: 'Georgia, "Times New Roman", serif',
    radiusCard: '3px',
    radiusCtl: '2px',
    borderW: '1px',
    borderStyle: 'solid',
    shadowLight: '1px 2px 0 rgba(62, 49, 25, .20)',
    shadowDark: '1px 2px 0 rgba(0, 0, 0, .48)',
    light: {
      page: '#f1e8d5', surface: '#fffaf0', surface2: '#e8dcc3', ink: '#302817', ink2: '#62563e', muted: '#6f624b',
      grid: '#d7c8aa', baseline: '#ad9a73', ring: 'rgba(48,40,23,.16)',
      stWishlist: '#c7b894', stArchive: '#e5dac4', ...ST_LIGHT,
    },
    dark: {
      page: '#17130d', surface: '#211c13', surface2: '#2b2418', ink: '#f1e7d2', ink2: '#c5b697', muted: '#8e8066',
      grid: '#3c3222', baseline: '#5b4c32', ring: 'rgba(241,231,210,.13)',
      stWishlist: '#594c35', stArchive: '#30281b', ...ST_DARK,
    },
    accents: [
      { id: 'fountain', name: 'Fountain blue', light: { acc: '#2856a1', accInk: '#ffffff' }, dark: { acc: '#82a9ef', accInk: '#102044' } },
      { id: 'redpencil', name: 'Red pencil', light: { acc: '#b23831', accInk: '#ffffff' }, dark: { acc: '#f0786c', accInk: '#32100c' } },
      { id: 'herb', name: 'Pressed herb', light: { acc: '#4f762e', accInk: '#ffffff' }, dark: { acc: '#a0ca74', accInk: '#1c2d0c' } },
      { id: 'ochre', name: 'Ochre', light: { acc: '#916000', accInk: '#ffffff' }, dark: { acc: '#e8b54b', accInk: '#2b1c00' } },
    ],
    densities: {
      compact: {
        baseSize: '13px', lineHeight: '1.4', headerPad: '9px 14px', sideWidth: '244px', sidePad: '10px',
        paneHeadPad: '10px 14px', viewPad: '11px 14px', columnWidth: '238px', columnGap: '10px', columnPad: '7px',
        cardGap: '6px', cardPad: '7px 9px 8px', controlPad: '3px 9px', fieldPad: '5px 8px', artHeight: '78px',
      },
      relaxed: {
        baseSize: '15px', lineHeight: '1.58', headerPad: '15px 22px', sideWidth: '300px', sidePad: '18px',
        paneHeadPad: '15px 22px', viewPad: '20px 22px', columnWidth: '294px', columnGap: '18px', columnPad: '12px',
        cardGap: '10px', cardPad: '10px 14px 12px', controlPad: '6px 14px', fieldPad: '8px 12px', artHeight: '108px',
      },
    },
  },
  {
    id: 'mochi',
    name: 'Mochi',
    blurb: 'playful candy bento with soft depth',
    font: 'ui-rounded, "SF Pro Rounded", system-ui, -apple-system, sans-serif',
    displayFont: 'ui-rounded, "SF Pro Rounded", system-ui, -apple-system, sans-serif',
    radiusCard: '20px',
    radiusCtl: '14px',
    borderW: '1px',
    borderStyle: 'solid',
    shadowLight: '0 12px 28px rgba(126, 79, 137, .14)',
    shadowDark: '0 14px 32px rgba(0, 0, 0, .38)',
    light: {
      page: '#faf3f8', surface: '#fffefe', surface2: '#f0e3f2', ink: '#33253a', ink2: '#685870', muted: '#75657d',
      grid: '#eadceb', baseline: '#d3c0d7', ring: 'rgba(51,37,58,.10)',
      stWishlist: '#d4c4d8', stArchive: '#eee4ef', ...ST_LIGHT,
    },
    dark: {
      page: '#17111c', surface: '#22182a', surface2: '#30213b', ink: '#f7eff9', ink2: '#cabbd0', muted: '#8f8098',
      grid: '#3b2b43', baseline: '#574062', ring: 'rgba(247,239,249,.10)',
      stWishlist: '#574062', stArchive: '#32243a', ...ST_DARK,
    },
    accents: [
      { id: 'strawberry', name: 'Strawberry', light: { acc: '#bd3f68', accInk: '#ffffff' }, dark: { acc: '#f087aa', accInk: '#36101e' } },
      { id: 'ube', name: 'Ube', light: { acc: '#7354c4', accInk: '#ffffff' }, dark: { acc: '#aa91ef', accInk: '#21143d' } },
      { id: 'matcha', name: 'Matcha', light: { acc: '#43783a', accInk: '#ffffff' }, dark: { acc: '#9ad28b', accInk: '#142a0f' } },
      { id: 'ramune', name: 'Ramune', light: { acc: '#2c70b2', accInk: '#ffffff' }, dark: { acc: '#8bc6ef', accInk: '#10283b' } },
    ],
    densities: {
      compact: {
        baseSize: '13px', lineHeight: '1.38', headerPad: '9px 13px', sideWidth: '246px', sidePad: '10px',
        paneHeadPad: '9px 13px', viewPad: '10px 13px', columnWidth: '236px', columnGap: '9px', columnPad: '7px',
        cardGap: '6px', cardPad: '7px 9px 8px', controlPad: '4px 10px', fieldPad: '5px 8px', artHeight: '78px',
      },
      relaxed: {
        baseSize: '14.5px', lineHeight: '1.54', headerPad: '15px 22px', sideWidth: '300px', sidePad: '17px',
        paneHeadPad: '15px 22px', viewPad: '19px 22px', columnWidth: '288px', columnGap: '17px', columnPad: '12px',
        cardGap: '10px', cardPad: '10px 14px 12px', controlPad: '7px 15px', fieldPad: '9px 12px', artHeight: '110px',
      },
    },
  },
  {
    id: 'blockparty',
    name: 'Block Party',
    blurb: 'graphic poster, loud ink, hard shadows',
    font: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
    displayFont: '"Arial Black", Impact, "Helvetica Neue", sans-serif',
    radiusCard: '0px',
    radiusCtl: '0px',
    borderW: '2px',
    borderStyle: 'solid',
    shadowLight: '5px 5px 0 #151515',
    shadowDark: '5px 5px 0 #f2ecde',
    light: {
      page: '#f2ead8', surface: '#fffdf5', surface2: '#ded5bd', ink: '#151515', ink2: '#3d3a32', muted: '#6e685a',
      grid: '#151515', baseline: '#686154', ring: 'rgba(21,21,21,.78)',
      stWishlist: '#c6bda7', stArchive: '#e1d9c5', ...ST_LIGHT,
    },
    dark: {
      page: '#11100e', surface: '#1c1a16', surface2: '#29261f', ink: '#f2ecde', ink2: '#cbc3b2', muted: '#918979',
      grid: '#f2ecde', baseline: '#918979', ring: 'rgba(242,236,222,.78)',
      stWishlist: '#413d34', stArchive: '#2b2822', ...ST_DARK,
    },
    accents: [
      { id: 'taxi', name: 'Taxi', light: { acc: '#f6c915', accInk: '#151515' }, dark: { acc: '#ffd62e', accInk: '#151515' } },
      { id: 'cobalt', name: 'Cobalt', light: { acc: '#2457df', accInk: '#ffffff' }, dark: { acc: '#6d91ff', accInk: '#10204e' } },
      { id: 'poppy', name: 'Poppy', light: { acc: '#cf2f26', accInk: '#ffffff' }, dark: { acc: '#ff7063', accInk: '#3a0d08' } },
      { id: 'acid', name: 'Acid', light: { acc: '#74ae00', accInk: '#151515' }, dark: { acc: '#b8ff3d', accInk: '#1b2b00' } },
    ],
    densities: {
      compact: {
        baseSize: '12.5px', lineHeight: '1.32', headerPad: '8px 11px', sideWidth: '232px', sidePad: '9px',
        paneHeadPad: '9px 11px', viewPad: '10px 11px', columnWidth: '224px', columnGap: '10px', columnPad: '6px',
        cardGap: '8px', cardPad: '6px 8px 7px', controlPad: '3px 9px', fieldPad: '4px 7px', artHeight: '70px',
      },
      relaxed: {
        baseSize: '14px', lineHeight: '1.46', headerPad: '14px 18px', sideWidth: '282px', sidePad: '15px',
        paneHeadPad: '14px 18px', viewPad: '18px 18px', columnWidth: '274px', columnGap: '17px', columnPad: '10px',
        cardGap: '12px', cardPad: '9px 12px 10px', controlPad: '6px 13px', fieldPad: '7px 10px', artHeight: '100px',
      },
    },
  },
];

export interface ThemeChoice {
  style: string;
  /** An accent id from the style's list, or 'custom' (uses `custom` hex). */
  accent: string;
  mode: 'system' | 'light' | 'dark';
  density: 'compact' | 'relaxed';
  /** Custom accent hex (#rrggbb) when accent === 'custom'. */
  custom: string | null;
}

export const DEFAULT_THEME: ThemeChoice = {
  style: 'harbor',
  accent: 'pacific',
  mode: 'system',
  density: 'relaxed',
  custom: null,
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function validTheme(t: Partial<ThemeChoice>): ThemeChoice {
  const style = STYLES.find((candidate) => candidate.id === t.style) ?? STYLES[0]!;
  const custom = typeof t.custom === 'string' && HEX_RE.test(t.custom) ? t.custom.toLowerCase() : null;
  let accent: string;
  if (t.accent === 'custom' && custom !== null) accent = 'custom';
  else accent = (style.accents.find((candidate) => candidate.id === t.accent) ?? style.accents[0]!).id;
  const mode = t.mode === 'light' || t.mode === 'dark' ? t.mode : 'system';
  const density = t.density === 'compact' ? 'compact' : 'relaxed';
  return { style: style.id, accent, mode, density, custom };
}
