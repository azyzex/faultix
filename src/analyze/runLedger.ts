/**
 * The run ledger.
 *
 * Faultix originally recorded only failures, which meant it could say "this
 * broke" but never "this stopped being broken". Recording successes as well is
 * what makes the interesting questions answerable:
 *
 *  - **Fix correlation.** The same command failed, then later passed. What was
 *    being edited in between? That is very often the fix, and nothing else in
 *    the editor remembers it.
 *  - **Flakiness.** The same command, at the same commit, disagreed with
 *    itself. That is not a bug in your code.
 *  - **What changed since it last passed.** Pure bookkeeping, and the first
 *    thing anyone asks.
 *
 * An agent cannot work any of this out on its own: it starts cold each session
 * and only sees the run it just performed.
 *
 * Pure: no `vscode`, no filesystem. The caller supplies records and persists
 * whatever comes back.
 */

import { inferKindFromCommand } from './classify';
import type { IncidentView } from '../output/templates';
import { normalizeCommand } from './fingerprint';

/** What a brief reports about a failure's past. Defined by the renderer. */
export type IncidentHistory = NonNullable<IncidentView['history']>;

export interface RunRecord {
  /** ISO timestamp of when the run finished. */
  at: string;
  /** Normalized command, so repeated runs of "the same" command group together. */
  commandKey: string;
  /** The command as typed, for display. */
  commandLine: string;
  ok: boolean;
  exitCode?: number;
  durationMs?: number;

  /** Commit the working tree was on, when known. */
  gitSha?: string;
  /** Whether the working tree had uncommitted changes. */
  gitDirty?: boolean;
  /** Repository-relative paths that were modified at the time. */
  changedFiles?: string[];

  /** Failure fingerprint. Present only on failing runs. */
  signature?: string;
  /** Id of the incident written for this run, when one was. */
  incidentId?: string;
  /** One-line summary of the failure, for history listings. */
  summary?: string;
}

export interface RunLedger {
  version: 1;
  /** Newest first. */
  runs: RunRecord[];
}

export function emptyLedger(): RunLedger {
  return { version: 1, runs: [] };
}

/** Default cap. Enough for weeks of work, small enough to read and parse fast. */
export const DEFAULT_MAX_RUNS = 500;

/**
 * Groups runs of "the same" command. `npm test`, `npm  test` and
 * `npm test --reporter=dot` should not all be distinct histories, but
 * `npm test` and `npm run build` must be.
 */
export function commandKeyOf(commandLine: string): string {
  return normalizeCommand(commandLine);
}

/** Prepends a run and trims the ledger to its cap. */
export function appendRun(ledger: RunLedger, run: RunRecord, maxRuns = DEFAULT_MAX_RUNS): RunLedger {
  const runs = [run, ...ledger.runs].slice(0, Math.max(1, maxRuns));
  return { version: 1, runs };
}

/** Narrows unknown JSON into a ledger, tolerating anything on disk. */
export function coerceLedger(value: unknown): RunLedger {
  if (!value || typeof value !== 'object') {
    return emptyLedger();
  }
  const candidate = value as Partial<RunLedger>;
  if (!Array.isArray(candidate.runs)) {
    return emptyLedger();
  }
  return { version: 1, runs: candidate.runs.filter(isRunRecord) };
}

function isRunRecord(value: unknown): value is RunRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<RunRecord>;
  return (
    typeof candidate.at === 'string' &&
    typeof candidate.commandKey === 'string' &&
    typeof candidate.ok === 'boolean'
  );
}

// --- Fix correlation --------------------------------------------------------

export interface Resolution {
  /** Fingerprint of the failure that went away. */
  signature: string;
  commandLine: string;
  failedAt: string;
  fixedAt: string;
  /** How many times it failed before it passed. */
  attempts: number;
  /**
   * Files being edited around the time it went away.
   *
   * A heuristic, and honest about being one: it is the working-tree changes
   * common to the failing and passing runs, falling back to their union. It
   * points at the right file far more often than not, but it cannot know which
   * edit mattered.
   */
  likelyFixedBy: string[];
  /**
   * True when the commit changed between the failure and the fix, which means
   * committed work is missing from `likelyFixedBy`.
   */
  commitsInBetween: boolean;
}

/**
 * Finds the most recent resolution for a failure signature.
 *
 * A failure counts as resolved when a later run of the same command succeeded
 * and no run of that signature has failed since.
 */
export function findResolution(ledger: RunLedger, signature: string): Resolution | undefined {
  // Runs arrive newest first; walking oldest-first makes the state machine
  // ("failing, then passing") read the way it happens.
  const runs = [...ledger.runs].reverse();

  let firstFailure: RunRecord | undefined;
  let attempts = 0;
  let resolution: Resolution | undefined;

  for (const run of runs) {
    if (!run.ok && run.signature === signature) {
      if (!firstFailure) {
        firstFailure = run;
      }
      attempts++;
      // A failure after a fix means the fix did not hold; start over.
      resolution = undefined;
      continue;
    }

    if (run.ok && firstFailure && run.commandKey === firstFailure.commandKey) {
      resolution = {
        signature,
        commandLine: firstFailure.commandLine,
        failedAt: firstFailure.at,
        fixedAt: run.at,
        attempts,
        likelyFixedBy: correlateChangedFiles(firstFailure, run),
        commitsInBetween: Boolean(
          firstFailure.gitSha && run.gitSha && firstFailure.gitSha !== run.gitSha
        )
      };
      firstFailure = undefined;
      attempts = 0;
    }
  }

  return resolution;
}

/** Every resolution the ledger knows about, newest fix first. */
export function findAllResolutions(ledger: RunLedger): Resolution[] {
  const signatures = new Set(
    ledger.runs.filter((run) => !run.ok && run.signature).map((run) => run.signature as string)
  );

  return [...signatures]
    .map((signature) => findResolution(ledger, signature))
    .filter((resolution): resolution is Resolution => resolution !== undefined)
    .sort((a, b) => b.fixedAt.localeCompare(a.fixedAt));
}

/**
 * The files common to both runs, or their union when there is no overlap.
 *
 * Overlap is the stronger signal: a file you were editing both when it broke
 * and when it worked is almost certainly the one you changed.
 */
function correlateChangedFiles(failure: RunRecord, success: RunRecord): string[] {
  const before = new Set(failure.changedFiles ?? []);
  const after = success.changedFiles ?? [];

  const common = after.filter((file) => before.has(file));
  if (common.length > 0) {
    return [...new Set(common)].sort();
  }

  return [...new Set([...(failure.changedFiles ?? []), ...after])].sort();
}

// --- Flakiness --------------------------------------------------------------

export interface FlakyCommand {
  commandKey: string;
  commandLine: string;
  passes: number;
  failures: number;
  /**
   * `high` when the disagreement happened at one commit with a clean tree, so
   * the code provably did not change. `low` when the tree was dirty and an
   * edit could explain it.
   */
  confidence: 'high' | 'low';
  /** The commit whose runs disagreed, when there is one. */
  conflictingSha?: string;
  lastSeen: string;
}

/**
 * Finds commands that disagreed with themselves.
 *
 * The strong case is the same commit with a clean working tree producing both
 * a pass and a failure: the code cannot have changed, so the test is flaky,
 * the environment is unstable, or there is a race. A dirty tree is reported
 * too, but marked low confidence, because an edit in between explains it just
 * as well.
 */
export function detectFlakyCommands(ledger: RunLedger): FlakyCommand[] {
  const byCommand = new Map<string, RunRecord[]>();

  for (const run of ledger.runs) {
    const existing = byCommand.get(run.commandKey);
    if (existing) {
      existing.push(run);
    } else {
      byCommand.set(run.commandKey, [run]);
    }
  }

  const flaky: FlakyCommand[] = [];

  for (const [commandKey, runs] of byCommand) {
    const passes = runs.filter((run) => run.ok).length;
    const failures = runs.length - passes;
    if (passes === 0 || failures === 0) {
      continue;
    }

    const bySha = new Map<string, RunRecord[]>();
    for (const run of runs) {
      if (!run.gitSha) {
        continue;
      }
      const existing = bySha.get(run.gitSha);
      if (existing) {
        existing.push(run);
      } else {
        bySha.set(run.gitSha, [run]);
      }
    }

    let confidence: FlakyCommand['confidence'] | undefined;
    let conflictingSha: string | undefined;

    for (const [sha, shaRuns] of bySha) {
      const disagreed = shaRuns.some((run) => run.ok) && shaRuns.some((run) => !run.ok);
      if (!disagreed) {
        continue;
      }

      const allClean = shaRuns.every((run) => run.gitDirty === false);
      if (allClean) {
        confidence = 'high';
        conflictingSha = sha;
        break;
      }
      confidence = 'low';
      conflictingSha = sha;
    }

    if (!confidence) {
      continue;
    }

    flaky.push({
      commandKey,
      commandLine: runs[0]?.commandLine ?? commandKey,
      passes,
      failures,
      confidence,
      conflictingSha,
      lastSeen: runs[0]?.at ?? ''
    });
  }

  return flaky.sort((a, b) => {
    if (a.confidence !== b.confidence) {
      return a.confidence === 'high' ? -1 : 1;
    }
    return b.lastSeen.localeCompare(a.lastSeen);
  });
}

// --- Command statistics -----------------------------------------------------

export interface CommandStats {
  commandKey: string;
  commandLine: string;
  runs: number;
  passes: number;
  failures: number;
  /** 0..1. */
  passRate: number;
  lastRunAt: string;
  lastPassAt?: string;
  lastFailAt?: string;
  /** Commit of the last run that passed, for "what changed since" queries. */
  lastPassSha?: string;
}

/** Summarizes one command's history, or undefined when it has never run. */
export function statsForCommand(ledger: RunLedger, commandKey: string): CommandStats | undefined {
  const runs = ledger.runs.filter((run) => run.commandKey === commandKey);
  if (!runs.length) {
    return undefined;
  }

  const passes = runs.filter((run) => run.ok);
  const failures = runs.filter((run) => !run.ok);

  return {
    commandKey,
    commandLine: runs[0]?.commandLine ?? commandKey,
    runs: runs.length,
    passes: passes.length,
    failures: failures.length,
    passRate: passes.length / runs.length,
    lastRunAt: runs[0]?.at ?? '',
    lastPassAt: passes[0]?.at,
    lastFailAt: failures[0]?.at,
    lastPassSha: passes[0]?.gitSha
  };
}

/** Every command the ledger has seen, most recently run first. */
export function allCommandStats(ledger: RunLedger): CommandStats[] {
  const keys = [...new Set(ledger.runs.map((run) => run.commandKey))];
  return keys
    .map((key) => statsForCommand(ledger, key))
    .filter((stats): stats is CommandStats => stats !== undefined)
    .sort((a, b) => b.lastRunAt.localeCompare(a.lastRunAt));
}

/**
 * The last run of this command that passed, if any.
 *
 * Callers use its commit to answer "what changed since this last worked",
 * which is the single most useful fact when something that used to work stops.
 */
export function lastPassingRun(ledger: RunLedger, commandKey: string): RunRecord | undefined {
  return ledger.runs.find((run) => run.ok && run.commandKey === commandKey);
}

/** How many times this exact failure has been recorded. */
export function occurrencesOf(ledger: RunLedger, signature: string): RunRecord[] {
  return ledger.runs.filter((run) => run.signature === signature);
}

/**
 * Whether a command is worth remembering.
 *
 * Recording every `cd` and `ls` would bury the builds and test runs that
 * matter, so a successful command is kept only when it looks like real work —
 * which is exactly the judgement the capture classifier already makes. A
 * failure is always worth keeping, whatever it was.
 */
export function shouldTrackRun(commandLine: string, ok: boolean): boolean {
  if (!commandLine.trim()) {
    return false;
  }
  if (!ok) {
    return true;
  }
  return inferKindFromCommand(commandLine) !== 'unknown';
}

/** Summarizes what the ledger knows about this failure and this command. */
export function deriveHistory(
  ledger: RunLedger,
  commandLine: string,
  signature: string,
  changesSincePass?: IncidentHistory['changesSincePass']
): IncidentHistory | undefined {
  const key = commandKeyOf(commandLine);

  const resolution = findResolution(ledger, signature);
  const lastPass = lastPassingRun(ledger, key);
  const stats = statsForCommand(ledger, key);
  const flaky = detectFlakyCommands(ledger).find((candidate) => candidate.commandKey === key);

  const history: IncidentHistory = {
    priorFix: resolution
      ? {
          fixedAt: resolution.fixedAt,
          likelyFixedBy: resolution.likelyFixedBy,
          attempts: resolution.attempts,
          commitsInBetween: resolution.commitsInBetween
        }
      : undefined,
    lastPassedAt: lastPass?.at,
    lastPassedSha: lastPass?.gitSha,
    passRate: stats?.passRate,
    totalRuns: stats?.runs,
    // A low-confidence disagreement means the command passed and failed at one
    // commit with a dirty tree — which is exactly what a fix looks like. When
    // one was recorded, saying "this is flaky" as well would contradict it.
    // A clean-tree disagreement is different: the code genuinely did not change.
    flaky: flaky && (flaky.confidence === 'high' || !resolution) ? flaky.confidence : undefined,
    changesSincePass
  };

  // Nothing worth saying is still nothing; keep the section off the brief
  // entirely. Listed field by field rather than via Object.values, which
  // erases optionality and would make the check look impossible.
  const hasAnything =
    history.priorFix !== undefined ||
    history.lastPassedAt !== undefined ||
    history.passRate !== undefined ||
    history.flaky !== undefined ||
    history.changesSincePass !== undefined;

  return hasAnything ? history : undefined;
}
