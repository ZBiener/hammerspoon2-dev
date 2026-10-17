/*
 * desktop_columns — tag-based desktop icon columns with LIFO overflow folders.
 * (Hammerspoon 2 / TypeScript port of desktop_columns.lua)
 *
 * Install:
 *   1. `npm run build` from hammerspoon2-dev/
 *   2. The active config loads the generated DesktopColumns Spoon.
 *   3. Finder → click the desktop → View → Show View Options:
 *        Sort By: None,  Label position: Right.  Also: View → Use Stacks OFF.
 *   4. Reload config. Approve the "control Finder" prompt.
 *
 * Behavior:
 *   • Columns right→left: untagged, Red, Green, Orange, Blue (empty ones collapse).
 *   • Within a column: folders first, then files; each oldest→newest by
 *     max(date added, date modified). Oldest at top.
 *   • If a column is over capacity, an "Overflow…" folder takes the top slot and the
 *     topmost items go into it. When room frees up, the item that went in last comes
 *     back out first. Empty overflow folders are deleted and the column moves up.
 *   • Original "date added" is kept in a hidden extended attribute so returning items
 *     sort back where they were.
 *
 * Hotkey (default ctrl-alt-cmd-D): re-run now. In the console,
 *   hs.spoons.DesktopColumns.probe()
 * prints the current Finder positions (useful for calibrating the offsets).
 */

import {
  Config,
  Frame,
  Item,
  Plan,
  groupFor,
  layout,
  overflowGroup,
  overflowName,
  planColumn,
  rows,
} from "./plan";

export const config: Config = {
  tagOrder: ["Red", "Green", "Orange", "Blue"],
  overflowBase: "Overflow",
  // Geometry (points). Adjust to match your View Options (icon size / grid spacing).
  colWidth: 200,
  rowHeight: 42,
  iconSize: 32,
  marginRight: 0,
  marginTop: 24,
  marginBottom: 10,
  offsetX: 0,
  offsetY: 0,
  debounce: 1.0,
  screenDelay: 3.0,
  hotkey: { mods: ["ctrl", "alt", "cmd"], key: "D" },
  exclude: [/\.download$/, /\.crdownload$/, /\.part$/, /\.partial$/],
};

// Extended attributes (v2 has no "#S" type suffix; values are plain strings).
const ATTR_ADDED = "com.zvi.desksort.added"; // original desktop "date added"
const ATTR_IN = "com.zvi.desksort.in"; // when it entered an overflow folder
const ATTR_RET = "com.zvi.desksort.returned"; // when it came back to the desktop
const ATTR_NAME = "com.zvi.desksort.name"; // original name if renamed on clash

const DESKTOP = `${hs.fs.homeDirectory()}/Desktop`;

interface DeskItem extends Item {
  added: number;
  modified: number;
  tags: string[];
  origAdded: number;
  dir: string;
}

interface ScanEntry {
  name: string;
  added: number;
  modified: number;
  isFolder: boolean;
  tags: string[];
}

interface ScanResult {
  entries: Record<string, ScanEntry[]>;
  errors: Record<string, string>;
}

const log = (...args: unknown[]): void => console.log("[DesktopColumns]", ...args);

// ---------------------------------------------------------------------------
// File / xattr helpers
// ---------------------------------------------------------------------------

function xget(path: string, attr: string): string | null {
  try {
    return hs.fs.xattrGet(path, attr, [], 0) ?? null;
  } catch {
    return null;
  }
}

function xset(path: string, attr: string, value: string | number): void {
  try {
    hs.fs.xattrSet(path, attr, String(value), [], 0);
  } catch (e) {
    log("xattr set failed:", path, attr, String(e));
  }
}

function xdel(path: string, attr: string): void {
  try {
    hs.fs.xattrRemove(path, attr, []);
  } catch {
    /* attribute wasn't there */
  }
}

const exists = (path: string): boolean => hs.fs.attributes(path) != null;

const excluded = (name: string): boolean => config.exclude.some((re) => re.test(name));

const num = (s: string | null): number | undefined => {
  if (s == null || s.trim() === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

/** Pick a free name in dir, adding " 2", " 3"… before the extension if needed. */
function freeName(dir: string, name: string, isFolder: boolean): string | null {
  if (!exists(`${dir}/${name}`)) return name;
  let base = name;
  let ext = "";
  if (!isFolder) {
    const m = name.match(/^(.+)(\.[^.]+)$/);
    if (m) {
      base = m[1];
      ext = m[2];
    }
  }
  for (let i = 2; i < 1000; i++) {
    const n = `${base} ${i}${ext}`;
    if (!exists(`${dir}/${n}`)) return n;
  }
  return null;
}

function moveItem(fromDir: string, name: string, toDir: string, isFolder: boolean, wantName?: string | null): string | null {
  const target = freeName(toDir, wantName || name, isFolder);
  if (!target) return null;
  if (!hs.fs.move(`${fromDir}/${name}`, `${toDir}/${target}`)) {
    log("move failed:", name, JSON.stringify(hs.fs.lastError));
    return null;
  }
  return target;
}

// ---------------------------------------------------------------------------
// Finder access (OSA)
// ---------------------------------------------------------------------------

/**
 * One JXA call: list items of each directory with date added, date modified,
 * folder/package flags and Finder tags. Hidden files are skipped.
 */
async function scanDirs(dirs: string[]): Promise<ScanResult | null> {
  const src = `
ObjC.import('Foundation');
(function () {
  const fm = $.NSFileManager.defaultManager;
  const dirs = ${JSON.stringify(dirs)};
  const keys = $.NSMutableArray.array;
  keys.addObject($.NSURLAddedToDirectoryDateKey);
  keys.addObject($.NSURLContentModificationDateKey);
  keys.addObject($.NSURLIsDirectoryKey);
  keys.addObject($.NSURLIsPackageKey);
  keys.addObject($.NSURLTagNamesKey);
  const valuesFor = u => ObjC.deepUnwrap(u.resourceValuesForKeysError(keys, $()));
  const seconds = date => date ? Date.parse(date) / 1000 : 0;
  const entries = {};
  const errors = {};
  dirs.forEach(d => {
    const items = fm.contentsOfDirectoryAtURLIncludingPropertiesForKeysOptionsError(
      $.NSURL.fileURLWithPath(d), $(), $.NSDirectoryEnumerationSkipsHiddenFiles, $());
    if (items.isNil()) {
      errors[d] = "directory could not be read";
      return;
    }
    const list = [];
    for (let i = 0; i < items.count; i++) {
      const u = items.objectAtIndex(i);
      const values = valuesFor(u);
      if (!values) continue;
      const isFolder = values.NSURLIsDirectoryKey === true && values.NSURLIsPackageKey !== true;
      let modified = seconds(values.NSURLContentModificationDateKey);
      if (isFolder) {
        // A folder's own mtime changes when it is moved or when Finder rewrites its
        // .DS_Store, so use its newest visible direct child (added or modified) instead.
        modified = 0;
        const kids = fm.contentsOfDirectoryAtURLIncludingPropertiesForKeysOptionsError(
          u, $(), $.NSDirectoryEnumerationSkipsHiddenFiles, $());
        if (!kids.isNil()) {
          for (let j = 0; j < kids.count; j++) {
            const k = kids.objectAtIndex(j);
            const childValues = valuesFor(k);
            if (!childValues) continue;
            modified = Math.max(
              modified,
              seconds(childValues.NSURLAddedToDirectoryDateKey),
              seconds(childValues.NSURLContentModificationDateKey),
            );
          }
        }
      }
      list.push({
        name: u.lastPathComponent.js,
        added: seconds(values.NSURLAddedToDirectoryDateKey),
        modified: modified,
        isFolder: isFolder,
        tags: values.NSURLTagNamesKey ?? []
      });
    }
    entries[d] = list;
  });
  return JSON.stringify({ entries: entries, errors: errors });
})();
`;
  const r = await hs.osascript.javascript(src);
  if (!r.success) {
    log("scan failed:", r.raw);
    return null;
  }
  return typeof r.result === "string" ? JSON.parse(r.result) : r.result;
}

async function setPositions(list: Array<{ name: string; x: number; y: number }>): Promise<void> {
  if (list.length === 0) return;
  const src = `
const desktop = Application("Finder").desktop;
const updates = ${JSON.stringify(list)};
const failures = [];
let changedCount = 0;
updates.forEach(update => {
  const name = update.name;
  const x = update.x;
  const y = update.y;
  try {
    const item = desktop.items.byName(name);
    const currentPosition = item.desktopPosition();
    if (currentPosition.x !== x || currentPosition.y !== y) {
      item.desktopPosition = { x: x, y: y };
      changedCount++;
    }
  } catch (e) {
    failures.push(name + ": " + String(e));
  }
});
JSON.stringify({ changedCount: changedCount, failures: failures });
`;
  const r = await hs.osascript.javascript(src);
  if (!r.success) {
    log("positioning failed:", r.raw);
    return;
  }
  const result = typeof r.result === "string" ? JSON.parse(r.result) : r.result;
  if (!result || typeof result.changedCount !== "number" || !Array.isArray(result.failures)) {
    log("positioning returned an invalid result:", r.result);
    return;
  }
  if (result.failures.length > 0) {
    log("could not position items:", result.failures.join("; "));
  } else {
    log("updated", result.changedCount, "of", list.length, "positions");
  }
}

// ---------------------------------------------------------------------------
// Main pass
// ---------------------------------------------------------------------------

let running = false;

/** Re-arrange now (also the hotkey action). If a pass is in flight, retry after the debounce. */
export async function run(): Promise<void> {
  if (running) {
    rerun.trigger();
    return;
  }
  running = true;
  try {
    await runPass();
  } catch (e) {
    log("error:", String(e));
  } finally {
    running = false;
  }
}

async function runPass(): Promise<void> {
  const cfg = config;
  const maxG = cfg.tagOrder.length;
  const screen = hs.screen.primary();
  if (!screen) {
    log("no primary screen; skipping pass");
    return;
  }
  const f = screen.frame;
  const frame: Frame = { x: f.x, y: f.y, w: f.w, h: f.h };
  const N = rows(frame, cfg);

  // Scan Desktop plus every possible overflow folder.
  const dirs = [DESKTOP];
  for (let g = 0; g <= maxG; g++) dirs.push(`${DESKTOP}/${overflowName(g, cfg)}`);
  const scan = await scanDirs(dirs);
  if (!scan) return;
  if (!scan.entries[DESKTOP]) {
    log("could not scan Desktop:", scan.errors[DESKTOP] ?? "no scan result");
    return;
  }
  log("scanned Desktop items:", scan.entries[DESKTOP].length);

  const desk: DeskItem[][] = [];
  const stack: DeskItem[][] = [];
  for (let g = 0; g <= maxG; g++) {
    desk[g] = [];
    stack[g] = [];
  }
  const folderExists: boolean[] = [];

  for (const e of scan.entries[DESKTOP]) {
    const og = overflowGroup(e.name, cfg);
    if (og !== null) {
      folderExists[og] = true;
    } else if (!excluded(e.name)) {
      const path = `${DESKTOP}/${e.name}`;
      let added = e.added;
      const stored = num(xget(path, ATTR_ADDED));
      const returned = num(xget(path, ATTR_RET));
      // Use the stored original date only if the item hasn't been re-added since it returned.
      if (stored !== undefined && returned !== undefined && added <= returned + 30) added = stored;
      const it: DeskItem = { ...e, origAdded: added, key: Math.max(added, e.modified), dir: DESKTOP };
      desk[groupFor(e.tags, cfg)].push(it);
    }
  }

  for (let g = 0; g <= maxG; g++) {
    const dir = `${DESKTOP}/${overflowName(g, cfg)}`;
    for (const e of scan.entries[dir] ?? []) {
      if (excluded(e.name)) continue;
      const path = `${dir}/${e.name}`;
      const origAdded = num(xget(path, ATTR_ADDED)) ?? e.added;
      const it: DeskItem = {
        ...e,
        dir,
        inTime: num(xget(path, ATTR_IN)) ?? e.added,
        origAdded,
        key: Math.max(origAdded, e.modified),
      };
      stack[groupFor(e.tags, cfg)].push(it); // retagged items follow their tag
    }
  }

  // Plan each column, then apply file moves.
  const plans: Array<Plan<DeskItem>> = [];
  const now = hs.timer.secondsSinceEpoch();
  for (let g = 0; g <= maxG; g++) {
    const p = planColumn(desk[g], stack[g], N);
    plans[g] = p;
    const ofDir = `${DESKTOP}/${overflowName(g, cfg)}`;

    if (p.needFolder && !folderExists[g]) {
      hs.fs.mkdir(ofDir);
      if (g > 0) {
        try {
          hs.fs.setTags(ofDir, [cfg.tagOrder[g - 1]]);
        } catch (e) {
          log("could not tag overflow folder:", String(e));
        }
      }
      folderExists[g] = true;
    }

    p.push.forEach((it, i) => {
      const src = `${it.dir}/${it.name}`;
      xset(src, ATTR_ADDED, it.origAdded);
      xset(src, ATTR_IN, now + (i + 1) * 0.001);
      const newName = moveItem(it.dir, it.name, ofDir, it.isFolder);
      if (newName && newName !== it.name) xset(`${ofDir}/${newName}`, ATTR_NAME, it.name);
      if (newName) {
        it.name = newName;
        it.dir = ofDir;
      }
    });

    for (const it of p.pop) {
      const src = `${it.dir}/${it.name}`;
      const want = xget(src, ATTR_NAME);
      xset(src, ATTR_ADDED, it.origAdded);
      const newName = moveItem(it.dir, it.name, DESKTOP, it.isFolder, want);
      if (newName) {
        const dst = `${DESKTOP}/${newName}`;
        xset(dst, ATTR_RET, now);
        xdel(dst, ATTR_IN);
        if (newName === want) xdel(dst, ATTR_NAME);
        it.name = newName;
        it.dir = DESKTOP;
      }
    }

    // Stack items sitting in the wrong overflow folder (retagged) → move them.
    for (const it of p.stack) {
      if (it.dir !== ofDir) {
        const newName = moveItem(it.dir, it.name, ofDir, it.isFolder);
        if (newName) {
          it.name = newName;
          it.dir = ofDir;
        }
      }
    }
  }

  // Delete overflow folders that are no longer needed (after all moves).
  for (let g = 0; g <= maxG; g++) {
    if (!plans[g].needFolder && folderExists[g]) {
      const ofDir = `${DESKTOP}/${overflowName(g, cfg)}`;
      if (exists(`${ofDir}/.DS_Store`)) hs.fs.deletePath(`${ofDir}/.DS_Store`);
      if (!hs.fs.rmdir(ofDir)) log("could not delete (not empty?):", ofDir);
    }
  }

  const placements = layout(plans, frame, cfg, maxG);
  log("planned desktop positions:", placements.length);
  await setPositions(placements);
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

type TimerHandle = ReturnType<typeof hs.timer.doAfter>;

/** Restartable one-shot timer ("delayed" in Hammerspoon 1). */
function debouncer(getDelay: () => number, fn: () => void) {
  let t: TimerHandle | null = null;
  return {
    trigger(): void {
      if (t) t.stop();
      t = hs.timer.doAfter(getDelay(), () => {
        t = null;
        fn();
      });
    },
    cancel(): void {
      if (t) t.stop();
      t = null;
    },
  };
}

const rerun = debouncer(() => config.debounce, () => void run());
const onScreen = debouncer(() => config.screenDelay, () => void run());

/** Only top-level desktop items and the contents of overflow folders matter; ignore hidden files. */
function relevant(path: string): boolean {
  if (!path.startsWith(DESKTOP + "/")) return false;
  const rel = path.slice(DESKTOP.length + 1);
  const parts = rel.split("/").filter((p) => p.length > 0);
  if (parts.length > 2) return false;
  if (parts.length === 1 && parts[0] === ".DS_Store") return true;
  return !parts.some((p) => p.startsWith(".")); // hidden temp files
}

let pathWatcher: ReturnType<typeof hs.fs.createPathWatcher> | null = null;
let hotkey: ReturnType<typeof hs.hotkey.bind> | null = null;
const screenListener = (): void => onScreen.trigger();

export function start(): void {
  stop();
  pathWatcher = hs.fs
    .createPathWatcher(DESKTOP)
    .setCallback((paths: string[]) => {
      const changed = paths.filter(relevant);
      if (changed.length > 0) {
        log("desktop changes detected:", changed.join(", "));
        rerun.trigger();
      }
    })
    .start();
  hs.screen.on("change", screenListener);
  const hk = config.hotkey;
  if (hk) hotkey = hs.hotkey.bind(hk.mods, hk.key, () => void run(), null, null);
  rerun.trigger();
  log("started");
}

export function stop(): void {
  if (pathWatcher) {
    pathWatcher.destroy();
    pathWatcher = null;
  }
  hs.screen.off("change", screenListener);
  if (hotkey) {
    hotkey.destroy();
    hotkey = null;
  }
  rerun.cancel();
  onScreen.cancel();
}

/** Print current Finder positions of desktop items (for calibration). */
export async function probe(): Promise<void> {
  const r = await hs.osascript.applescript(`
tell application "Finder"
  set out to ""
  repeat with f in (every item of desktop)
    set p to desktop position of f
    set out to out & (name of f) & "  " & (item 1 of p) & "," & (item 2 of p) & linefeed
  end repeat
  return out
end tell`);
  console.log(r.success ? r.result : r.raw);
}
