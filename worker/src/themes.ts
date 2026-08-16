// The style catalog: five looks over one structural stylesheet. A style sets
// shape (radius, borders, shadows, font, density) and palettes per mode; an
// accent recolors chrome (buttons, meters, links) — never the six canonical
// state colors, which stay semantic and CVD-validated as a set.

export interface Palette {
  page: string;
  surface: string;
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

export interface Style {
  id: string;
  name: string;
  blurb: string;
  font: string;
  radiusCard: string;
  radiusCtl: string;
  borderW: string;
  /** CSS border-style for hairlines/cards — solid, dashed, … */
  borderStyle: string;
  shadowLight: string;
  shadowDark: string;
  light: Palette;
  dark: Palette;
  accents: Accent[];
}

// Canonical state colors (validated: strip order wishlist·todo·blocked·doing·
// done·archive passes CVD adjacency in both modes; neutrals are deliberately
// recessive and always chip-labeled).
const ST_LIGHT = { stTodo: '#898781', stBlocked: '#d03b3b', stDoing: '#2a78d6', stDone: '#0ca30c' };
const ST_DARK = { stTodo: '#898781', stBlocked: '#d03b3b', stDoing: '#3987e5', stDone: '#0ca30c' };

export const STYLES: Style[] = [
  {
    id: 'reef',
    name: 'Reef',
    blurb: 'calm neutral — the default',
    font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    radiusCard: '10px',
    radiusCtl: '6px',
    borderW: '1px',
    borderStyle: 'solid',
    shadowLight: '0 1px 3px rgba(0,0,0,.06)',
    shadowDark: '0 1px 3px rgba(0,0,0,.45)',
    light: {
      page: '#f9f9f7', surface: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781',
      grid: '#e1e0d9', baseline: '#c3c2b7', ring: 'rgba(11,11,11,.10)',
      stWishlist: '#c3c2b7', stArchive: '#e1e0d9', ...ST_LIGHT,
    },
    dark: {
      page: '#0d0d0d', surface: '#1a1a19', ink: '#ffffff', ink2: '#c3c2b7', muted: '#898781',
      grid: '#2c2c2a', baseline: '#383835', ring: 'rgba(255,255,255,.10)',
      stWishlist: '#383835', stArchive: '#2c2c2a', ...ST_DARK,
    },
    accents: [
      { id: 'reef', name: 'Reef blue', light: { acc: '#2a78d6', accInk: '#ffffff' }, dark: { acc: '#3987e5', accInk: '#ffffff' } },
      { id: 'lagoon', name: 'Lagoon', light: { acc: '#0e8f83', accInk: '#ffffff' }, dark: { acc: '#17b3a5', accInk: '#03211e' } },
      { id: 'coral', name: 'Coral', light: { acc: '#d95b43', accInk: '#ffffff' }, dark: { acc: '#f07a5f', accInk: '#33120a' } },
      { id: 'grape', name: 'Grape', light: { acc: '#6c4bd1', accInk: '#ffffff' }, dark: { acc: '#9a7ef0', accInk: '#1c1040' } },
    ],
  },
  {
    id: 'phosphor',
    name: 'Phosphor',
    blurb: 'terminal — mono, dense, square',
    font: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    radiusCard: '0px',
    radiusCtl: '0px',
    borderW: '1px',
    borderStyle: 'solid',
    shadowLight: 'none',
    shadowDark: 'none',
    light: {
      page: '#eff0e6', surface: '#f9faf0', ink: '#1c241e', ink2: '#48544a', muted: '#78847a',
      grid: '#d6d9c6', baseline: '#b4b9a4', ring: 'rgba(28,36,30,.14)',
      stWishlist: '#b4b9a4', stArchive: '#d6d9c6', ...ST_LIGHT,
    },
    dark: {
      page: '#060a06', surface: '#0c130c', ink: '#d7f2dc', ink2: '#9fc3a6', muted: '#6d8a72',
      grid: '#1c291e', baseline: '#2c3c2e', ring: 'rgba(215,242,220,.14)',
      stWishlist: '#2c3c2e', stArchive: '#182418', ...ST_DARK,
    },
    accents: [
      { id: 'green', name: 'Phosphor green', light: { acc: '#0a7a33', accInk: '#ffffff' }, dark: { acc: '#37d97a', accInk: '#06240f' } },
      { id: 'amber', name: 'Amber', light: { acc: '#9c5f00', accInk: '#ffffff' }, dark: { acc: '#e0a63a', accInk: '#241703' } },
      { id: 'ice', name: 'Ice', light: { acc: '#0b6a8a', accInk: '#ffffff' }, dark: { acc: '#59d8e6', accInk: '#04252a' } },
    ],
  },
  {
    id: 'papercut',
    name: 'Papercut',
    blurb: 'warm paper, ruled-card borders',
    font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    radiusCard: '4px',
    radiusCtl: '3px',
    borderW: '1.5px',
    borderStyle: 'solid',
    shadowLight: 'none',
    shadowDark: 'none',
    light: {
      page: '#f5efe2', surface: '#fdf9ee', ink: '#2c2618', ink2: '#5c5340', muted: '#8c8168',
      grid: '#e2d7bd', baseline: '#c8bb9b', ring: 'rgba(44,38,24,.14)',
      stWishlist: '#c8bb9b', stArchive: '#e2d7bd', ...ST_LIGHT,
    },
    dark: {
      page: '#171410', surface: '#201c15', ink: '#ece4d2', ink2: '#b8ac92', muted: '#877d66',
      grid: '#322c20', baseline: '#443d2d', ring: 'rgba(236,228,210,.12)',
      stWishlist: '#443d2d', stArchive: '#322c20', ...ST_DARK,
    },
    accents: [
      { id: 'inkwell', name: 'Inkwell', light: { acc: '#2f4fae', accInk: '#ffffff' }, dark: { acc: '#7d97e8', accInk: '#101a36' } },
      { id: 'redpen', name: 'Red-pen', light: { acc: '#b4342c', accInk: '#ffffff' }, dark: { acc: '#e06a5e', accInk: '#2b0f0c' } },
      { id: 'moss', name: 'Moss', light: { acc: '#4a7c2f', accInk: '#ffffff' }, dark: { acc: '#8fbf6f', accInk: '#14260b' } },
    ],
  },
  {
    id: 'mochi',
    name: 'Mochi',
    blurb: 'soft, plush, pastel',
    font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    radiusCard: '14px',
    radiusCtl: '10px',
    borderW: '1px',
    borderStyle: 'solid',
    shadowLight: '0 4px 14px rgba(150,110,160,.13)',
    shadowDark: '0 4px 14px rgba(0,0,0,.5)',
    light: {
      page: '#faf6fa', surface: '#ffffff', ink: '#2a2331', ink2: '#5f5568', muted: '#948a9c',
      grid: '#ece2ef', baseline: '#d4c6da', ring: 'rgba(42,35,49,.10)',
      stWishlist: '#d4c6da', stArchive: '#ece2ef', ...ST_LIGHT,
    },
    dark: {
      page: '#16121a', surface: '#201a26', ink: '#f2ecf6', ink2: '#c2b6cc', muted: '#8d8298',
      grid: '#2f2738', baseline: '#453a52', ring: 'rgba(242,236,246,.10)',
      stWishlist: '#453a52', stArchive: '#2f2738', ...ST_DARK,
    },
    accents: [
      { id: 'ichigo', name: 'Ichigo', light: { acc: '#d6537f', accInk: '#ffffff' }, dark: { acc: '#e87ba0', accInk: '#33101d' } },
      { id: 'ume', name: 'Ume', light: { acc: '#7d5bc6', accInk: '#ffffff' }, dark: { acc: '#a58ae8', accInk: '#1e1236' } },
      { id: 'matcha', name: 'Matcha', light: { acc: '#58924a', accInk: '#ffffff' }, dark: { acc: '#97d189', accInk: '#10260c' } },
      { id: 'sora', name: 'Sora', light: { acc: '#4a7dd6', accInk: '#ffffff' }, dark: { acc: '#8fb3f0', accInk: '#0d1d3d' } },
    ],
  },
  {
    id: 'bricks',
    name: 'Bricks',
    blurb: 'neobrutalist — thick borders, hard shadows',
    font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    radiusCard: '0px',
    radiusCtl: '0px',
    borderW: '2px',
    borderStyle: 'solid',
    shadowLight: '4px 4px 0 #141414',
    shadowDark: '4px 4px 0 rgba(232,228,218,.9)',
    light: {
      page: '#efe9dc', surface: '#fffdf6', ink: '#141414', ink2: '#3c3a34', muted: '#6e6a60',
      grid: '#141414', baseline: '#6e6a60', ring: 'rgba(20,20,20,.85)',
      stWishlist: '#c9c3b2', stArchive: '#e3ddcc', ...ST_LIGHT,
    },
    dark: {
      page: '#121212', surface: '#1b1b1b', ink: '#f2eee4', ink2: '#c9c4b6', muted: '#8f8a7c',
      grid: '#e8e4da', baseline: '#8f8a7c', ring: 'rgba(232,228,218,.85)',
      stWishlist: '#3a3a36', stArchive: '#2a2a26', ...ST_DARK,
    },
    accents: [
      { id: 'taxi', name: 'Taxi', light: { acc: '#f5c518', accInk: '#141414' }, dark: { acc: '#f5c518', accInk: '#141414' } },
      { id: 'cobalt', name: 'Cobalt', light: { acc: '#2456e0', accInk: '#ffffff' }, dark: { acc: '#5b82f0', accInk: '#0c1e4d' } },
      { id: 'poppy', name: 'Poppy', light: { acc: '#e0342b', accInk: '#ffffff' }, dark: { acc: '#ff6b5e', accInk: '#330b07' } },
    ],
  },
  {
    id: 'vapor',
    name: 'Vapor',
    blurb: 'synthwave — neon glow on deep violet',
    font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    radiusCard: '8px',
    radiusCtl: '6px',
    borderW: '1px',
    borderStyle: 'solid',
    shadowLight: '0 2px 10px rgba(150,60,200,.16)',
    shadowDark: '0 0 14px rgba(255,61,220,.22)',
    light: {
      page: '#f4eefc', surface: '#fdf9ff', ink: '#241536', ink2: '#5c4880', muted: '#907eb0',
      grid: '#e2d4f4', baseline: '#c5aee6', ring: 'rgba(36,21,54,.12)',
      stWishlist: '#c5aee6', stArchive: '#e2d4f4', ...ST_LIGHT,
    },
    dark: {
      page: '#0a0118', surface: '#160b2e', ink: '#f2e9ff', ink2: '#c0aee0', muted: '#8a76b0',
      grid: '#2c1b52', baseline: '#43307a', ring: 'rgba(255,61,220,.35)',
      stWishlist: '#43307a', stArchive: '#241245', ...ST_DARK,
    },
    accents: [
      { id: 'hotline', name: 'Hotline', light: { acc: '#c1179e', accInk: '#ffffff' }, dark: { acc: '#ff3ddc', accInk: '#2a0124' } },
      { id: 'cyandream', name: 'Cyan dream', light: { acc: '#0d7fa8', accInk: '#ffffff' }, dark: { acc: '#3de8ff', accInk: '#002229' } },
      { id: 'sunset', name: 'Sunset', light: { acc: '#d1521f', accInk: '#ffffff' }, dark: { acc: '#ff7a45', accInk: '#2b0f00' } },
    ],
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    blurb: 'cyanotype — dashed drafting lines',
    font: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    radiusCard: '2px',
    radiusCtl: '2px',
    borderW: '1px',
    borderStyle: 'dashed',
    shadowLight: 'none',
    shadowDark: 'none',
    light: {
      page: '#eef3f8', surface: '#fbfdff', ink: '#10314f', ink2: '#3d5c78', muted: '#7490a8',
      grid: '#a9c2d6', baseline: '#8fb0c8', ring: 'rgba(16,49,79,.16)',
      stWishlist: '#b9cede', stArchive: '#dbe6ef', ...ST_LIGHT,
    },
    dark: {
      page: '#071e33', surface: '#0d2a45', ink: '#dcebf8', ink2: '#a8c4dc', muted: '#6f92b2',
      grid: '#2e5678', baseline: '#3e6a90', ring: 'rgba(220,235,248,.22)',
      stWishlist: '#2e5678', stArchive: '#16334d', ...ST_DARK,
    },
    accents: [
      { id: 'drafting', name: 'Drafting', light: { acc: '#1d5f9e', accInk: '#ffffff' }, dark: { acc: '#7ec3ff', accInk: '#04263e' } },
      { id: 'redline', name: 'Redline', light: { acc: '#c23b2a', accInk: '#ffffff' }, dark: { acc: '#ff8a75', accInk: '#33100a' } },
    ],
  },
  {
    id: 'newsprint',
    name: 'Newsprint',
    blurb: 'stark serif black & white',
    font: 'Georgia, "Times New Roman", serif',
    radiusCard: '0px',
    radiusCtl: '0px',
    borderW: '1px',
    borderStyle: 'solid',
    shadowLight: 'none',
    shadowDark: 'none',
    light: {
      page: '#f7f5ef', surface: '#fffefa', ink: '#191919', ink2: '#444440', muted: '#757068',
      grid: '#c6c0b2', baseline: '#191919', ring: 'rgba(25,25,25,.25)',
      stWishlist: '#c6c0b2', stArchive: '#e5e0d4', ...ST_LIGHT,
    },
    dark: {
      page: '#121110', surface: '#1c1a17', ink: '#efece4', ink2: '#c2bdb0', muted: '#8b867a',
      grid: '#4a463e', baseline: '#efece4', ring: 'rgba(239,236,228,.25)',
      stWishlist: '#3a3730', stArchive: '#2a2823', ...ST_DARK,
    },
    accents: [
      { id: 'ink', name: 'Ink', light: { acc: '#191919', accInk: '#fffefa' }, dark: { acc: '#efece4', accInk: '#191919' } },
      { id: 'crimson', name: 'Crimson', light: { acc: '#a31621', accInk: '#ffffff' }, dark: { acc: '#e05252', accInk: '#2b0a0d' } },
      { id: 'union', name: 'Union', light: { acc: '#1c4e9e', accInk: '#ffffff' }, dark: { acc: '#7da3e8', accInk: '#0c1c3d' } },
    ],
  },
];

export interface ThemeChoice {
  style: string;
  /** An accent id from the style's list, or 'custom' (uses `custom` hex). */
  accent: string;
  mode: 'system' | 'light' | 'dark';
  /** Custom accent hex (#rrggbb) when accent === 'custom'. */
  custom: string | null;
}

export const DEFAULT_THEME: ThemeChoice = { style: 'reef', accent: 'reef', mode: 'system', custom: null };

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function validTheme(t: Partial<ThemeChoice>): ThemeChoice {
  const style = STYLES.find((s) => s.id === t.style) ?? STYLES[0]!;
  const custom = typeof t.custom === 'string' && HEX_RE.test(t.custom) ? t.custom.toLowerCase() : null;
  let accent: string;
  if (t.accent === 'custom' && custom !== null) accent = 'custom';
  else accent = (style.accents.find((a) => a.id === t.accent) ?? style.accents[0]!).id;
  const mode = t.mode === 'light' || t.mode === 'dark' ? t.mode : 'system';
  return { style: style.id, accent, mode, custom };
}
