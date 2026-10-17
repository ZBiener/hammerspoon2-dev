export interface Snippet {
  uid: string;
  name?: string;
  keyword: string;
  snippet?: string;
  dontautoexpand?: boolean;
  collection?: string;
}

export interface Pattern {
  tokens: string[];
  snippet: Snippet;
}

export function tokenize(text: string): string[] {
  return text
    .replace(/\{[^}]*\}/g, " ")
    .replace(/['\u2018\u2019]/g, "")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function withinOneEdit(first: string, second: string): boolean {
  const a = Array.from(first);
  const b = Array.from(second);
  if (Math.abs(a.length - b.length) > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }

    if (++edits > 1) return false;
    if (a.length > b.length) {
      i++;
    } else if (b.length > a.length) {
      j++;
    } else {
      if (a[i] === b[j + 1] && a[i + 1] === b[j]) {
        i++;
        j++;
      }
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function tokensEqual(first: string, second: string): boolean {
  if (first === second) return true;
  return first.length >= 4 && second.length >= 4 && withinOneEdit(first, second);
}

function longestCommonSubsequence(pattern: string[], words: string[]): number {
  let previous = new Array<number>(words.length + 1).fill(0);
  for (const token of pattern) {
    const current = new Array<number>(words.length + 1).fill(0);
    for (let j = 1; j <= words.length; j++) {
      current[j] = tokensEqual(token, words[j - 1])
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous[words.length];
}

function matches(pattern: Pattern, words: string[]): boolean {
  const tokens = pattern.tokens;
  const length = tokens.length;
  if (words.length === 0 || length === 0) return false;

  const last = words[words.length - 1];
  if (length === 1) return last === tokens[0];

  const endsHere = tokensEqual(last, tokens[length - 1]) ||
    (length >= 5 && tokensEqual(last, tokens[length - 2]));
  if (!endsHere) return false;

  const slack = length <= 4 ? 2 : 3;
  const window = words.slice(Math.max(0, words.length - (length + slack)));
  const matched = longestCommonSubsequence(tokens, window);
  return length <= 4 ? matched === length : matched >= 3 && matched / length >= 0.75;
}

export function buildPatterns(snippets: Snippet[]): Pattern[] {
  const patterns: Pattern[] = [];
  for (const snippet of snippets) {
    if (snippet.dontautoexpand || !snippet.keyword) continue;

    const seen = new Set<string>();
    const add = (tokens: string[]): void => {
      const key = tokens.join(" ");
      if (tokens.length === 0 || seen.has(key)) return;
      seen.add(key);
      patterns.push({ tokens, snippet });
    };

    const expansion = tokenize(snippet.snippet ?? "");
    if (expansion.length >= 2) {
      add(expansion);
    } else if (expansion.length === 1) {
      const plain = (snippet.snippet ?? "")
        .replace(/\{[^}]*\}/g, "")
        .trim();
      if (expansion[0].length >= 5 && plain.length >= snippet.keyword.length + 3) {
        add(expansion);
      }
    }

    const title = tokenize(snippet.name ?? "");
    if (title.length >= 2) add(title);
  }
  return patterns;
}

export function findMatch(patterns: Pattern[], words: string[]): Snippet | null {
  for (const pattern of patterns) {
    if (matches(pattern, words)) return pattern.snippet;
  }
  return null;
}
