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
    ],
  },
];

export interface ThemeChoice {
  style: string;
  accent: string;
  mode: 'system' | 'light' | 'dark';
}

export const DEFAULT_THEME: ThemeChoice = { style: 'reef', accent: 'reef', mode: 'system' };

export function validTheme(t: Partial<ThemeChoice>): ThemeChoice {
  const style = STYLES.find((s) => s.id === t.style) ?? STYLES[0]!;
  const accent = style.accents.find((a) => a.id === t.accent) ?? style.accents[0]!;
  const mode = t.mode === 'light' || t.mode === 'dark' ? t.mode : 'system';
  return { style: style.id, accent: accent.id, mode };
}
