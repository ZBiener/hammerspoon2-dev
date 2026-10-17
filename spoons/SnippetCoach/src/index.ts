import { buildPatterns, findMatch, Snippet, tokenize } from "./matching";

interface CoachConfig {
  snippetsDir: string;
  excludeCollections: Record<string, boolean>;
  excludeApps: Record<string, boolean>;
  cooldownSeconds: number;
  alertSeconds: number;
  textSize: number;
  statsFileName: string;
}

interface SnippetStats {
  misses: number;
  keyword?: string;
  name?: string;
  collection?: string;
  lastMiss?: string;
}

interface AlfredSnippetFile {
  alfredsnippet?: Snippet;
}

function isStatsRecord(value: unknown): value is Record<string, SnippetStats> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return typeof item.misses === "number" && Number.isFinite(item.misses) &&
      (item.keyword === undefined || typeof item.keyword === "string") &&
      (item.name === undefined || typeof item.name === "string") &&
      (item.collection === undefined || typeof item.collection === "string") &&
      (item.lastMiss === undefined || typeof item.lastMiss === "string");
  });
}

const log = (...values: unknown[]): void => console.log("[SnippetCoach]", ...values);
const error = (...values: unknown[]): void => console.error("[SnippetCoach]", ...values);

const config: CoachConfig = {
  snippetsDir: `${hs.fs.homeDirectory()}/Library/CloudStorage/Dropbox/AppSync/Alfred.alfredpreferences/snippets`,
  excludeCollections: { Memorized: true, AutoCorrect: true },
  excludeApps: {},
  cooldownSeconds: 600,
  alertSeconds: 4,
  textSize: 22,
  statsFileName: "snippet_coach_stats.json",
};

const keyCodes = hs.keycodes.map;
const codeFor = (name: string): number | undefined => keyCodes[name];
const resetKeys = new Set(
  ["left", "right", "up", "down", "escape", "forwarddelete", "home", "end", "pageup", "pagedown"]
    .map(codeFor)
    .filter((code): code is number => code !== undefined),
);
const deleteKey = codeFor("delete");
const spaceKeys = new Set(
  ["return", "padenter", "tab"]
    .map(codeFor)
    .filter((code): code is number => code !== undefined),
);

let buffer = "";
let patterns: ReturnType<typeof buildPatterns> = [];
let snippets: Snippet[] = [];
let lastShown: Record<string, number> = {};
let stats: Record<string, SnippetStats> = {};
let statsWritable = true;
let eventTap: HSEventTap | null = null;
let watchdog: HSTimer | null = null;
let pathWatcher: HSPathWatcher | null = null;
let reloadTimer: HSTimer | null = null;
let alert: HSUIAlert | null = null;

function statsPath(): string {
  return `${hs.appinfo.configDir}/${config.statsFileName}`;
}

function readStats(): void {
  stats = {};
  statsWritable = true;
  const path = statsPath();
  if (!hs.fs.exists(path)) return;

  const contents = hs.fs.read(path, 0, 0);
  if (contents === null) {
    statsWritable = false;
    error(`could not read stats at ${path}; existing data will not be overwritten`);
    return;
  }

  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isStatsRecord(parsed)) throw new Error("expected an object of valid snippet stats");
    stats = parsed;
  } catch (e) {
    statsWritable = false;
    error(`could not parse stats at ${path}; existing data will not be overwritten:`, String(e));
  }
}

function loadSnippets(): Snippet[] | null {
  const collectionNames = hs.fs.list(config.snippetsDir);
  if (collectionNames === null) {
    error(`could not list Alfred snippets at ${config.snippetsDir}`);
    return null;
  }

  const result: Snippet[] = [];
  for (const collection of collectionNames) {
    const collectionPath = `${config.snippetsDir}/${collection}`;
    if (collection.startsWith(".") || config.excludeCollections[collection] ||
        !hs.fs.isDirectory(collectionPath)) continue;

    const files = hs.fs.list(collectionPath);
    if (files === null) {
      error(`could not list Alfred snippet collection ${collectionPath}`);
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const path = `${collectionPath}/${file}`;
      const contents = hs.fs.read(path, 0, 0);
      if (contents === null) {
        error(`could not read Alfred snippet ${path}`);
        continue;
      }
      try {
        const data = JSON.parse(contents) as AlfredSnippetFile;
        const snippet = data.alfredsnippet;
        if (!snippet || typeof snippet.uid !== "string" ||
            typeof snippet.keyword !== "string") continue;
        snippet.collection = collection;
        result.push(snippet);
      } catch (e) {
        error(`could not parse Alfred snippet ${path}:`, String(e));
      }
    }
  }
  return result;
}

function reload(): boolean {
  const loaded = loadSnippets();
  if (loaded === null) return false;
  snippets = loaded;
  patterns = buildPatterns(snippets);
  log(`loaded ${snippets.length} snippets and ${patterns.length} match patterns`);
  return true;
}

function saveStats(): void {
  if (!statsWritable) return;
  if (!hs.fs.write(statsPath(), JSON.stringify(stats, null, 2))) {
    error(`could not save stats to ${statsPath()}`);
  }
}

function showTip(snippet: Snippet): void {
  const now = Date.now() / 1000;
  if (lastShown[snippet.uid] !== undefined &&
      now - lastShown[snippet.uid] < config.cooldownSeconds) return;
  lastShown[snippet.uid] = now;

  const expansion = (snippet.snippet ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\{cursor\}/g, "")
    .trim();
  if (alert !== null) alert.close();
  alert = hs.ui.alert(`${snippet.keyword}\n${expansion}`)
    .font(HSFont.system(config.textSize))
    .duration(config.alertSeconds + Math.min(Math.max(expansion.split("\n").length - 1, 0), 6) * 0.75)
    .padding(22)
    .show();

  const item = stats[snippet.uid] ?? { misses: 0 };
  item.misses++;
  item.keyword = snippet.keyword;
  item.name = snippet.name;
  item.collection = snippet.collection;
  const nowDate = new Date();
  item.lastMiss = [
    nowDate.getFullYear(),
    String(nowDate.getMonth() + 1).padStart(2, "0"),
    String(nowDate.getDate()).padStart(2, "0"),
  ].join("-") + ` ${String(nowDate.getHours()).padStart(2, "0")}:${String(nowDate.getMinutes()).padStart(2, "0")}`;
  stats[snippet.uid] = item;
  saveStats();
}

function evaluate(): void {
  const application = hs.application.frontmost();
  if (application?.bundleID && config.excludeApps[application.bundleID]) return;
  const snippet = findMatch(patterns, tokenize(buffer));
  if (snippet !== null) {
    buffer = "";
    showTip(snippet);
  }
}

function onEvent(event: HSEventTapEvent): void {
  if (event.type === hs.eventtap.eventTypes.leftMouseDown) {
    buffer = "";
    return;
  }

  const code = event.keyCode;
  if (event.flags.includes("cmd") || event.flags.includes("ctrl")) {
    buffer = "";
    return;
  }
  if (code === deleteKey) {
    buffer = Array.from(buffer).slice(0, -1).join("");
    return;
  }
  if (resetKeys.has(code)) {
    buffer = "";
    return;
  }

  let characters = event.characters;
  if (spaceKeys.has(code)) characters = " ";
  if (!characters || /^[\p{C}]/u.test(characters)) return;

  buffer += characters;
  const chars = Array.from(buffer);
  if (chars.length > 300) buffer = chars.slice(-300).join("");
  if (!/^[\p{L}\p{N}_'’‘]/u.test(characters)) {
    hs.timer.doAfter(0, evaluate);
  }
}

function stop(): void {
  if (watchdog !== null) watchdog.stop();
  if (reloadTimer !== null) reloadTimer.stop();
  if (pathWatcher !== null) pathWatcher.stop();
  if (eventTap !== null) hs.eventtap.removeWatcher(eventTap);
  if (alert !== null) alert.close();
  watchdog = null;
  reloadTimer = null;
  pathWatcher = null;
  eventTap = null;
  alert = null;
  buffer = "";
}

function start(): typeof snippetCoach {
  stop();
  readStats();
  reload();

  eventTap = hs.eventtap.addWatcher(
    [hs.eventtap.eventTypes.keyDown, hs.eventtap.eventTypes.leftMouseDown],
    (event) => {
      onEvent(event);
      return undefined;
    },
    true,
  );
  if (eventTap === null) {
    throw new Error("could not create keyboard watcher; grant Hammerspoon 2 Accessibility permission");
  }
  eventTap.start();

  watchdog = hs.timer.doEvery(5, () => {
    if (eventTap !== null && !eventTap.isEnabled()) {
      log("restarting disabled keyboard watcher");
      eventTap.start();
    }
  });

  if (hs.fs.isDirectory(config.snippetsDir)) {
    pathWatcher = hs.fs.createPathWatcher(config.snippetsDir)
      .setCallback(() => {
        if (reloadTimer !== null) reloadTimer.stop();
        reloadTimer = hs.timer.doAfter(2, () => {
          reloadTimer = null;
          reload();
        });
      })
      .start();
  } else {
    error(`Alfred snippets directory is unavailable; automatic reload is disabled: ${config.snippetsDir}`);
  }
  log("started; typed text is kept only in a short in-memory buffer");
  return snippetCoach;
}

const snippetCoach = {
  author: "ZBiener",
  description: "Reminds you of Alfred snippet keywords when you type out their expansions.",
  version: "1.0.0",
  config,
  get snippets(): Snippet[] {
    return snippets;
  },
  start,
  stop,
  reload,
  stats: (): Record<string, SnippetStats> => stats,
};

export { snippetCoach };
