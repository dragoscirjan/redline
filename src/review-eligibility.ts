import { createHash } from 'node:crypto';

export const REVIEW_ELIGIBILITY_POLICY_VERSION = 1 as const;
export const DEFAULT_REVIEW_ELIGIBILITY_PATH = '.redline/review-eligibility.json';
export const MAX_REVIEW_ELIGIBILITY_BYTES = 16 * 1024;
export const MAX_REVIEW_ELIGIBILITY_INCLUDE_RULES = 32;
export const MAX_REVIEW_ELIGIBILITY_EXCLUDE_RULES = 64;
export const MAX_REVIEW_ELIGIBILITY_PATTERN_CHARS = 256;
export const MAX_REVIEW_ELIGIBILITY_REASON_CHARS = 200;

const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

export interface ReviewEligibilityExcludeRule {
  readonly pattern: string;
  readonly reason: string;
}

export interface ReviewEligibilityPolicy {
  readonly version: typeof REVIEW_ELIGIBILITY_POLICY_VERSION;
  readonly include: readonly string[];
  readonly exclude: readonly ReviewEligibilityExcludeRule[];
}

export type ReviewEligibilityPolicySource = 'built-in' | 'trusted-base' | 'trusted-workflow';

export interface ReviewEligibilityPolicyMetadata {
  readonly version: typeof REVIEW_ELIGIBILITY_POLICY_VERSION;
  readonly source: ReviewEligibilityPolicySource;
  readonly path: string | null;
  readonly digest: string | null;
  readonly includeRules: number;
  readonly excludeRules: number;
}

export interface ReviewEligibilityDecision {
  readonly reviewed: boolean;
  readonly reason: string | null;
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`${label} contains an unsupported field: ${key}`);
  }
}

function boundedText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
  if (value !== value.trim() || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function validatePattern(value: unknown, label: string): string {
  const pattern = boundedText(value, MAX_REVIEW_ELIGIBILITY_PATTERN_CHARS, label);
  if (pattern.startsWith('/') || pattern.endsWith('/') || pattern.includes('\\')) {
    throw new Error(`${label} must be a repository-relative slash-separated glob`);
  }
  const segments = pattern.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`${label} contains an invalid path segment`);
  }
  if (segments.some((segment) => segment.includes('**') && segment !== '**')) {
    throw new Error(`${label} supports ** only as a complete path segment`);
  }
  return pattern;
}

export function parseReviewEligibilityPolicy(raw: string): ReviewEligibilityPolicy {
  if (Buffer.byteLength(raw, 'utf8') > MAX_REVIEW_ELIGIBILITY_BYTES) {
    throw new Error('review eligibility policy exceeds its byte limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('review eligibility policy must be valid JSON');
  }
  if (!isRecord(parsed)) throw new Error('review eligibility policy must be an object');
  assertOnlyKeys(parsed, ['version', 'include', 'exclude'], 'review eligibility policy');
  if (parsed.version !== REVIEW_ELIGIBILITY_POLICY_VERSION) {
    throw new Error('review eligibility policy uses an unsupported version');
  }
  if (!Array.isArray(parsed.include) || parsed.include.length > MAX_REVIEW_ELIGIBILITY_INCLUDE_RULES) {
    throw new Error(`review eligibility policy include must contain at most ${MAX_REVIEW_ELIGIBILITY_INCLUDE_RULES} rules`);
  }
  if (!Array.isArray(parsed.exclude) || parsed.exclude.length > MAX_REVIEW_ELIGIBILITY_EXCLUDE_RULES) {
    throw new Error(`review eligibility policy exclude must contain at most ${MAX_REVIEW_ELIGIBILITY_EXCLUDE_RULES} rules`);
  }
  const include = parsed.include.map((value, index) => validatePattern(value, `include[${index}]`));
  const exclude = parsed.exclude.map((value, index): ReviewEligibilityExcludeRule => {
    const label = `exclude[${index}]`;
    if (!isRecord(value)) throw new Error(`${label} must be an object`);
    assertOnlyKeys(value, ['pattern', 'reason'], label);
    return {
      pattern: validatePattern(value.pattern, `${label}.pattern`),
      reason: boundedText(value.reason, MAX_REVIEW_ELIGIBILITY_REASON_CHARS, `${label}.reason`),
    };
  });
  return Object.freeze({ version: REVIEW_ELIGIBILITY_POLICY_VERSION, include, exclude });
}

function segmentPattern(pattern: string): RegExp {
  let source = '^';
  for (const character of pattern) {
    if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`${source}$`, 'u');
}

export function matchesReviewEligibilityPattern(pattern: string, path: string): boolean {
  const patternSegments = pattern.split('/');
  const pathSegments = path.split('/');
  const memo = new Map<string, boolean>();
  const matches = (patternIndex: number, pathIndex: number): boolean => {
    const key = `${patternIndex}:${pathIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (patternIndex === patternSegments.length) {
      result = pathIndex === pathSegments.length;
    } else if (patternSegments[patternIndex] === '**') {
      result = matches(patternIndex + 1, pathIndex)
        || (pathIndex < pathSegments.length && matches(patternIndex, pathIndex + 1));
    } else {
      result = pathIndex < pathSegments.length
        && segmentPattern(patternSegments[patternIndex] as string).test(pathSegments[pathIndex] as string)
        && matches(patternIndex + 1, pathIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return matches(0, 0);
}

export function policyDigest(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function decideReviewEligibility(
  paths: readonly string[],
  policy: ReviewEligibilityPolicy | undefined,
): ReviewEligibilityDecision {
  if (policy === undefined) return { reviewed: true, reason: null };
  if (paths.includes(DEFAULT_REVIEW_ELIGIBILITY_PATH)) {
    return { reviewed: true, reason: null };
  }
  const excludedByPath = paths.map((path) => policy.exclude.find(
    (rule) => matchesReviewEligibilityPattern(rule.pattern, path),
  ));
  if (excludedByPath.length > 0 && excludedByPath.every((rule) => rule !== undefined)) {
    const reasons = [...new Set(excludedByPath.flatMap((rule) => rule === undefined ? [] : [rule.reason]))];
    return {
      reviewed: false,
      reason: reasons.length === 1
        ? reasons[0] as string
        : 'all old and new paths match trusted exclusion rules',
    };
  }
  if (policy.include.length > 0 && !paths.some((path) =>
    policy.include.some((pattern) => matchesReviewEligibilityPattern(pattern, path)))) {
    return { reviewed: false, reason: 'outside trusted review include policy' };
  }
  return { reviewed: true, reason: null };
}
