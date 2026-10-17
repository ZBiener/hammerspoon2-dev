// Pure planning/layout logic for desktop_columns — no hs.* calls, unit-testable in Node.

export interface Config {
  tagOrder: string[]; // column order after "untagged"
  overflowBase: string; // untagged: "Overflow"; others: "Overflow – Red" …
  colWidth: number; // icon + label width per column
  rowHeight: number; // vertical distance between icons
  iconSize: number; // used to convert column/row slots to icon centers
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  offsetX: number; // calibration nudges added to every position
  offsetY: number;
  debounce: number; // seconds of quiet before re-arranging
  screenDelay: number; // wait after display changes (Finder reshuffles first)
  hotkey: { mods: string[]; key: string } | null;
  exclude: RegExp[]; // items whose names match any of these are ignored entirely
}

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An item on the desktop (or in an overflow folder). */
export interface Item {
  name: string;
  isFolder: boolean;
  key: number; // max(date added, date modified); smaller = older = nearer the top
  inTime?: number; // when it entered an overflow folder (stack ordering)
  [extra: string]: unknown;
}

export interface Plan<T extends Item = Item> {
  desk: T[]; // final ordered desktop items
  stack: T[]; // final overflow stack (bottom → top)
  push: T[]; // desktop → overflow, in order
  pop: T[]; // overflow → desktop
  needFolder: boolean;
}

export interface Placement {
  name: string;
  x: number;
  y: number;
  col: number;
  row: number;
}

const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);

/** Group index: 0 = untagged, i = 1-based position in tagOrder (first match wins). */
export function groupFor(tags: string[] | null | undefined, cfg: Pick<Config, "tagOrder">): number {
  if (tags) {
    const have = new Set(tags.map((t) => t.toLowerCase()));
    for (let i = 0; i < cfg.tagOrder.length; i++) {
      if (have.has(cfg.tagOrder[i].toLowerCase())) return i + 1;
    }
  }
  return 0;
}

export function overflowName(g: number, cfg: Pick<Config, "tagOrder" | "overflowBase">): string {
  if (g === 0) return cfg.overflowBase;
  return `${cfg.overflowBase} – ${cfg.tagOrder[g - 1]}`;
}

/** name → group index if it is one of our overflow folder names, else null. */
export function overflowGroup(name: string, cfg: Pick<Config, "tagOrder" | "overflowBase">): number | null {
  for (let g = 0; g <= cfg.tagOrder.length; g++) {
    if (name === overflowName(g, cfg)) return g;
  }
  return null;
}

function deskLess(a: Item, b: Item): number {
  if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1; // folders first
  if (a.key !== b.key) return cmp(a.key, b.key);
  return cmp(a.name, b.name);
}

function stackLess(a: Item, b: Item): number {
  const ai = a.inTime ?? 0;
  const bi = b.inTime ?? 0;
  if (ai !== bi) return cmp(ai, bi);
  return cmp(a.name, b.name);
}

/**
 * Plan one column.
 *   desk  : items on the desktop
 *   stack : items in its overflow folder
 *   N     : slots in a column
 */
export function planColumn<T extends Item>(desk: T[], stack: T[], N: number): Plan<T> {
  N = Math.max(N, 2);
  const d = [...desk];
  let s = [...stack];
  d.sort(deskLess);
  s.sort(stackLess);
  const push: T[] = [];
  const pop: T[] = [];

  if (d.length + s.length <= N) {
    for (let i = s.length - 1; i >= 0; i--) {
      pop.push(s[i]);
      d.push(s[i]);
    }
    s = [];
  } else {
    const slots = N - 1; // top slot is the overflow folder
    while (d.length > slots) {
      // topmost items go in
      const it = d.shift() as T;
      push.push(it);
      s.push(it);
    }
    while (d.length < slots && s.length > 0) {
      // last in, first out
      const it = s.pop() as T;
      pop.push(it);
      d.push(it);
    }
  }
  d.sort(deskLess);
  return { desk: d, stack: s, push, pop, needFolder: s.length > 0 };
}

/** Compute icon positions. `plans[g]` for g = 0..maxG; frame = main screen frame. */
export function layout(plans: Array<Plan | undefined>, frame: Frame, cfg: Config, maxG: number): Placement[] {
  const out: Placement[] = [];
  let col = 0;
  const half = cfg.iconSize / 2;
  for (let g = 0; g <= maxG; g++) {
    const p = plans[g];
    if (p && (p.desk.length > 0 || p.needFolder)) {
      const left = frame.x + frame.w - cfg.marginRight - (col + 1) * cfg.colWidth;
      const x = Math.floor(left + half + cfg.offsetX);
      let row = 0;
      const place = (name: string): void => {
        const y = Math.floor(frame.y + cfg.marginTop + row * cfg.rowHeight + half + cfg.offsetY);
        out.push({ name, x, y, col, row });
        row++;
      };
      if (p.needFolder) place(overflowName(g, cfg));
      for (const it of p.desk) place(it.name);
      col++;
    }
  }
  return out;
}

export function rows(frame: Frame, cfg: Pick<Config, "marginTop" | "marginBottom" | "rowHeight">): number {
  return Math.floor((frame.h - cfg.marginTop - cfg.marginBottom) / cfg.rowHeight);
}
