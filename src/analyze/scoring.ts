/**
 * Suspect ranking.
 *
 * Given everything Faultix observed about a failure, decide which files are
 * worth looking at first. The output is what an agent reads before it opens
 * anything, so precision matters more than recall: three good suspects beat
 * fifteen plausible ones.
 *
 * The central rule is **corroboration**. Open editor diagnostics are cheap and
 * ambient — a workspace can have hundreds of warnings that have nothing to do
 * with the command that just failed. Diagnostics therefore count for very
 * little on their own, and count properly only when the same file also appears
 * in the failure output. When there is no terminal evidence at all (a
 * diagnostics-spike incident), diagnostics become the primary signal instead.
 *
 * Pure: no `vscode` import.
 */

import { isGeneratedPath, isIgnoredPath, isTestPath, toPosix } from './paths';

export interface FileRef {
  file: string;
  line?: number;
  column?: number;
}

export interface DiagnosticCount {
  file: string;
  errors: number;
  warnings: number;
}

export interface SuspectEvidence {
  /** File named by the highest-confidence extracted error, if any. */
  primaryErrorFile?: FileRef;
  /** Files named by any extracted error, strongest first. */
  errorRefs?: FileRef[];
  /** Files merely mentioned somewhere in the terminal output. */
  terminalRefs?: FileRef[];
  /** Files named as arguments on the failing command line. */
  commandRefs?: FileRef[];
  /** Open editor diagnostics, per file. */
  diagnostics?: DiagnosticCount[];
  /** Files with uncommitted changes in the working tree. */
  gitChangedFiles?: string[];
}

export interface RankedSuspect {
  file: string;
  score: number;
  reasons: string[];
  /** Best known line number within the file, when one was observed. */
  line?: number;
}

export interface RankingOptions {
  /** Cap on returned suspects. */
  limit?: number;
  /** Extra directory names to treat as vendored. */
  ignoredSegments?: readonly string[];
  /** Drop suspects scoring below this after penalties. */
  minScore?: number;
}

/** Point values, gathered here so the ranking model is legible in one place. */
const WEIGHT = {
  primaryError: 100,
  errorRef: 55,
  /** Each subsequent error reference is worth slightly less than the last. */
  errorRefDecay: 6,
  errorRefFloor: 20,
  commandRef: 45,
  terminalRef: 22,
  /** Diagnostics that agree with the failure output. */
  corroboratedDiagnosticError: 6,
  corroboratedDiagnosticErrorCap: 30,
  corroboratedDiagnosticWarning: 1,
  corroboratedDiagnosticWarningCap: 5,
  /** Diagnostics with no support from the failure output. */
  ambientDiagnosticError: 2,
  ambientDiagnosticErrorCap: 10,
  ambientDiagnosticWarning: 0.25,
  ambientDiagnosticWarningCap: 2,
  /** Diagnostics when they are the only evidence available. */
  soleDiagnosticError: 12,
  soleDiagnosticErrorCap: 60,
  soleDiagnosticWarning: 2,
  soleDiagnosticWarningCap: 12,
  gitChangedCorroborated: 15,
  gitChangedAlone: 4
} as const;

/** Multipliers applied after accumulation. */
const PENALTY = {
  ignored: 0.15,
  generated: 0.4,
  test: 0.9
} as const;

interface Accumulator {
  file: string;
  score: number;
  reasons: string[];
  line?: number;
  /** True when the failure output itself implicated this file. */
  corroborated: boolean;
}

/**
 * Ranks the files most likely to be responsible for a failure.
 */
export function rankSuspects(evidence: SuspectEvidence, options: RankingOptions = {}): RankedSuspect[] {
  const limit = options.limit ?? 10;
  const minScore = options.minScore ?? 1;
  const accumulators = new Map<string, Accumulator>();

  const get = (file: string): Accumulator | undefined => {
    const key = normalizeKey(file);
    if (!key) {
      return undefined;
    }
    let entry = accumulators.get(key);
    if (!entry) {
      entry = { file: toPosix(file), score: 0, reasons: [], corroborated: false };
      accumulators.set(key, entry);
    }
    return entry;
  };

  const add = (ref: FileRef | string, points: number, reason: string, corroborating: boolean): void => {
    const file = typeof ref === 'string' ? ref : ref.file;
    const line = typeof ref === 'string' ? undefined : ref.line;

    const entry = get(file);
    if (!entry) {
      return;
    }

    entry.score += points;
    if (!entry.reasons.includes(reason)) {
      entry.reasons.push(reason);
    }
    if (entry.line === undefined && line !== undefined) {
      entry.line = line;
    }
    if (corroborating) {
      entry.corroborated = true;
    }
  };

  // 1. The file the primary error points at is the single strongest signal.
  if (evidence.primaryErrorFile?.file) {
    add(evidence.primaryErrorFile, WEIGHT.primaryError, 'Named by the primary error', true);
  }

  // 2. Other files named by parsed errors, with a gentle decay down the list.
  (evidence.errorRefs ?? []).forEach((ref, i) => {
    const points = Math.max(WEIGHT.errorRefFloor, WEIGHT.errorRef - i * WEIGHT.errorRefDecay);
    add(ref, points, 'Named by a parsed error', true);
  });

  // 3. Files passed to the failing command are usually the thing being run.
  for (const ref of evidence.commandRefs ?? []) {
    add(ref, WEIGHT.commandRef, 'Passed to the failing command', true);
  }

  // 4. Files merely mentioned in the output (stack frames, log lines).
  for (const ref of evidence.terminalRefs ?? []) {
    add(ref, WEIGHT.terminalRef, 'Mentioned in the failure output', true);
  }

  // 5. Diagnostics. Their weight depends entirely on whether anything else
  //    already implicated the file, which is why they are applied last.
  const hasOutputEvidence = accumulators.size > 0;

  for (const diagnostic of evidence.diagnostics ?? []) {
    const entry = get(diagnostic.file);
    if (!entry) {
      continue;
    }

    const tier = !hasOutputEvidence ? 'sole' : entry.corroborated ? 'corroborated' : 'ambient';

    if (diagnostic.errors > 0) {
      const [per, cap] =
        tier === 'sole'
          ? [WEIGHT.soleDiagnosticError, WEIGHT.soleDiagnosticErrorCap]
          : tier === 'corroborated'
            ? [WEIGHT.corroboratedDiagnosticError, WEIGHT.corroboratedDiagnosticErrorCap]
            : [WEIGHT.ambientDiagnosticError, WEIGHT.ambientDiagnosticErrorCap];

      entry.score += Math.min(diagnostic.errors * per, cap);
      pushReason(entry, `${diagnostic.errors} error diagnostic${diagnostic.errors === 1 ? '' : 's'}`);
    }

    if (diagnostic.warnings > 0) {
      const [per, cap] =
        tier === 'sole'
          ? [WEIGHT.soleDiagnosticWarning, WEIGHT.soleDiagnosticWarningCap]
          : tier === 'corroborated'
            ? [WEIGHT.corroboratedDiagnosticWarning, WEIGHT.corroboratedDiagnosticWarningCap]
            : [WEIGHT.ambientDiagnosticWarning, WEIGHT.ambientDiagnosticWarningCap];

      const points = Math.min(diagnostic.warnings * per, cap);
      if (points >= 1) {
        entry.score += points;
        pushReason(entry, `${diagnostic.warnings} warning diagnostic${diagnostic.warnings === 1 ? '' : 's'}`);
      }
    }
  }

  // 6. Recent edits explain most breakage, but only once something else has
  //    pointed at the file; otherwise every dirty file would rank.
  for (const file of evidence.gitChangedFiles ?? []) {
    const entry = get(file);
    if (!entry) {
      continue;
    }
    const alreadyImplicated = entry.score > 0;
    entry.score += alreadyImplicated ? WEIGHT.gitChangedCorroborated : WEIGHT.gitChangedAlone;
    pushReason(entry, 'Modified in the working tree');
  }

  // When the failure output named files, a file known only from ambient editor
  // diagnostics is not a suspect - it is background noise that happens to be
  // open. It still appears in the diagnostics section of the brief.
  if (hasOutputEvidence) {
    for (const [key, entry] of accumulators) {
      if (!entry.corroborated) {
        accumulators.delete(key);
      }
    }
  }

  return finalize(accumulators, { limit, minScore, ignoredSegments: options.ignoredSegments ?? [] });
}

function pushReason(entry: Accumulator, reason: string): void {
  if (!entry.reasons.includes(reason)) {
    entry.reasons.push(reason);
  }
}

/** Applies penalties, filters, sorts and truncates. */
function finalize(
  accumulators: Map<string, Accumulator>,
  options: { limit: number; minScore: number; ignoredSegments: readonly string[] }
): RankedSuspect[] {
  const results: RankedSuspect[] = [];

  for (const entry of accumulators.values()) {
    let score = entry.score;
    const reasons = [...entry.reasons];

    if (isIgnoredPath(entry.file, options.ignoredSegments)) {
      score *= PENALTY.ignored;
      reasons.push('Vendored or build output, unlikely to be the cause');
    }
    if (isGeneratedPath(entry.file)) {
      score *= PENALTY.generated;
      reasons.push('Generated file');
    }
    if (isTestPath(entry.file)) {
      score *= PENALTY.test;
    }

    if (score < options.minScore) {
      continue;
    }

    results.push({
      file: entry.file,
      score: Math.round(score),
      reasons: tidyReasons(reasons),
      line: entry.line
    });
  }

  results.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.file.localeCompare(b.file)));
  return results.slice(0, options.limit);
}

/**
 * Removes reasons that a stronger reason already implies. Being "named by the
 * primary error" says everything that "named by a parsed error" and "mentioned
 * in the failure output" would add.
 */
function tidyReasons(reasons: string[]): string[] {
  const implied: Record<string, string[]> = {
    'Named by the primary error': ['Named by a parsed error', 'Mentioned in the failure output'],
    'Named by a parsed error': ['Mentioned in the failure output'],
    'Passed to the failing command': ['Mentioned in the failure output']
  };

  const drop = new Set<string>();
  for (const reason of reasons) {
    for (const weaker of implied[reason] ?? []) {
      drop.add(weaker);
    }
  }

  return reasons.filter((reason) => !drop.has(reason));
}

/**
 * Collapses the many spellings of one path into a single key. Windows and
 * macOS are case-insensitive, and the same file arrives as `./src/a.ts`,
 * `src/a.ts` and `C:\repo\src\a.ts` depending on which tool printed it.
 */
export function normalizeKey(file: string): string {
  const posix = toPosix(file).trim();
  if (!posix) {
    return '';
  }
  return posix
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Merges references that describe the same file, keeping the earliest line.
 * Callers pass raw parser output, which repeats the same path constantly.
 */
export function dedupeRefs(refs: FileRef[]): FileRef[] {
  const seen = new Map<string, FileRef>();
  for (const ref of refs) {
    const key = normalizeKey(ref.file);
    if (!key) {
      continue;
    }
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, ref);
      continue;
    }
    if (existing.line === undefined && ref.line !== undefined) {
      seen.set(key, { ...existing, line: ref.line, column: ref.column });
    }
  }
  return [...seen.values()];
}
