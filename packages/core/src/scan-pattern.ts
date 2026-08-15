export const MAX_SCAN_PATTERN_COUNT = 256;
export const MAX_SCAN_PATTERN_LENGTH = 1_024;
export const MAX_SCAN_LOGICAL_PATH_LENGTH = 8_192;

type SegmentToken =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "one" }
  | { readonly kind: "many" };

type PatternSegment =
  | { readonly kind: "globstar" }
  | { readonly kind: "segment"; readonly tokens: readonly SegmentToken[] };

export interface CanonicalScanPattern {
  readonly canonical: string;
  readonly segments: readonly PatternSegment[];
}

export interface ScanPathPermissionInput {
  readonly path: string;
  readonly container: boolean;
  readonly includeSets: readonly (readonly string[])[];
  readonly exclude: readonly string[];
}

export function parseScanPatterns(patterns: readonly string[]): readonly CanonicalScanPattern[] {
  if (patterns.length > MAX_SCAN_PATTERN_COUNT) {
    throw new Error("Scan pattern count exceeds the supported limit");
  }
  return patterns.map(parseScanPattern);
}

export function matchesScanPattern(path: string, pattern: string): boolean {
  return matchesSegments(parseLogicalPath(path), parseScanPattern(pattern).segments);
}

export function isScanPathPermitted(input: ScanPathPermissionInput): boolean {
  const totalPatterns = input.exclude.length
    + input.includeSets.reduce((total, patterns) => total + patterns.length, 0);
  if (totalPatterns > MAX_SCAN_PATTERN_COUNT) {
    throw new Error("Scan pattern count exceeds the supported limit");
  }
  const path = parseLogicalPath(input.path);
  const includeSets = input.includeSets.map((patterns) => parseScanPatterns(patterns));
  const exclude = parseScanPatterns(input.exclude);
  const included = includeSets.every((patterns) => patterns.some((pattern) => (
    input.container
      ? canPatternMatchAtOrBelow(path, pattern.segments)
      : matchesSegments(path, pattern.segments)
  )));
  return included && !exclude.some((pattern) => matchesSegments(path, pattern.segments));
}

function parseScanPattern(pattern: string): CanonicalScanPattern {
  if (pattern.length > MAX_SCAN_PATTERN_LENGTH) {
    throw new Error("Scan pattern length exceeds the supported limit");
  }
  if (pattern.length === 0 || pattern.includes("\\") || !wellFormedUtf16(pattern)) {
    throw invalidPattern();
  }
  const canonical = pattern.startsWith("/") ? pattern : `/${pattern}`;
  if (canonical !== "/" && canonical.endsWith("/")) throw invalidPattern();
  const rawSegments = canonical === "/" ? [] : canonical.slice(1).split("/");
  if (rawSegments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw invalidPattern();
  }
  return {
    canonical,
    segments: rawSegments.map(parsePatternSegment),
  };
}

function parsePatternSegment(segment: string): PatternSegment {
  if (segment === "**") return { kind: "globstar" };
  if (segment.includes("**") || containsUnsupportedGrammar(segment)) throw invalidPattern();
  const tokens: SegmentToken[] = [];
  for (const character of Array.from(segment)) {
    if (isControlCharacter(character)) throw invalidPattern();
    if (character === "*") tokens.push({ kind: "many" });
    else if (character === "?") tokens.push({ kind: "one" });
    else tokens.push({ kind: "literal", value: character });
  }
  return { kind: "segment", tokens };
}

function parseLogicalPath(path: string): readonly string[] {
  if (path.length === 0 || path.length > MAX_SCAN_LOGICAL_PATH_LENGTH
    || !path.startsWith("/") || path.includes("\\") || !wellFormedUtf16(path)
    || path !== "/" && path.endsWith("/")) {
    throw new Error("Scan logical path is invalid");
  }
  const segments = path === "/" ? [] : path.slice(1).split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".."
    || Array.from(segment).some(isControlCharacter))) {
    throw new Error("Scan logical path is invalid");
  }
  return segments;
}

function matchesSegments(path: readonly string[], pattern: readonly PatternSegment[]): boolean {
  let states = epsilonClosure(new Set([0]), pattern);
  for (const segment of path) {
    states = consumeSegment(states, segment, pattern);
    if (states.size === 0) return false;
  }
  return states.has(pattern.length);
}

function canPatternMatchAtOrBelow(
  containerPath: readonly string[],
  pattern: readonly PatternSegment[],
): boolean {
  let states = epsilonClosure(new Set([0]), pattern);
  for (const segment of containerPath) {
    states = consumeSegment(states, segment, pattern);
    if (states.size === 0) return false;
  }
  return states.size > 0;
}

function consumeSegment(
  states: ReadonlySet<number>,
  segment: string,
  pattern: readonly PatternSegment[],
): Set<number> {
  const next = new Set<number>();
  for (const state of states) {
    const matcher = pattern[state];
    if (matcher?.kind === "globstar") next.add(state);
    else if (matcher?.kind === "segment" && matchesSegment(segment, matcher.tokens)) {
      next.add(state + 1);
    }
  }
  return epsilonClosure(next, pattern);
}

function epsilonClosure(states: ReadonlySet<number>, pattern: readonly PatternSegment[]): Set<number> {
  const result = new Set(states);
  const pending = [...states];
  while (pending.length > 0) {
    const state = pending.pop()!;
    if (pattern[state]?.kind !== "globstar" || result.has(state + 1)) continue;
    result.add(state + 1);
    pending.push(state + 1);
  }
  return result;
}

function matchesSegment(value: string, pattern: readonly SegmentToken[]): boolean {
  const characters = Array.from(value);
  let patternIndex = 0;
  let valueIndex = 0;
  let lastStar = -1;
  let lastStarMatch = -1;
  while (valueIndex < characters.length) {
    const token = pattern[patternIndex];
    if (token?.kind === "one"
      || token?.kind === "literal" && token.value === characters[valueIndex]) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (token?.kind === "many") {
      lastStar = patternIndex;
      lastStarMatch = valueIndex;
      patternIndex += 1;
    } else if (lastStar >= 0) {
      patternIndex = lastStar + 1;
      lastStarMatch += 1;
      valueIndex = lastStarMatch;
    } else return false;
  }
  while (pattern[patternIndex]?.kind === "many") patternIndex += 1;
  return patternIndex === pattern.length;
}

function containsUnsupportedGrammar(segment: string): boolean {
  return Array.from(segment).some((character) => "[]{}()!".includes(character));
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return codePoint <= 0x1f || codePoint === 0x7f;
}

function wellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function invalidPattern(): Error {
  return new Error("Scan pattern grammar is invalid");
}
