/**
 * Working-tree context.
 *
 * "What changed recently" answers a surprising share of failures, so a brief
 * carries the branch, whether the tree is dirty, and which files are modified.
 * Everything here is best effort: a workspace with no git, no git binary, or a
 * slow filesystem must degrade to "no git evidence" rather than delay a
 * capture.
 */

import { execGit } from './gitExec';

export interface GitEvidence {
  enabled: boolean;
  insideWorkTree: boolean;
  branch?: string;
  /**
   * Current commit. Recorded so the run ledger can tell a genuine fix (the
   * commit moved) from a flaky command (it did not).
   */
  sha?: string;
  isDirty?: boolean;
  /** Repository-relative paths with uncommitted changes. */
  changedFiles?: string[];
  diffStat?: string;

  /**
   * What has changed since a given commit, when the caller asked.
   *
   * "What changed since this last worked" is the first question anyone asks
   * when something that used to pass starts failing, and it is pure
   * bookkeeping to answer.
   */
  changesSince?: {
    sha: string;
    files: string[];
    diffStat?: string;
    commits?: number;
  };
}

/** Cap on files listed, so a huge refactor does not swamp the brief. */
const MAX_CHANGED_FILES = 100;

/** Cap on diffstat characters kept. */
const MAX_DIFFSTAT_CHARS = 4000;

export async function collectGitEvidence(args: {
  enabled: boolean;
  workspaceRoot: string | undefined;
  /** Commit to diff against, usually the last one where this command passed. */
  sinceSha?: string;
}): Promise<GitEvidence> {
  if (!args.enabled || !args.workspaceRoot) {
    return { enabled: args.enabled, insideWorkTree: false };
  }

  const cwd = args.workspaceRoot;

  const inside = await execGit(['rev-parse', '--is-inside-work-tree'], cwd);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { enabled: true, insideWorkTree: false };
  }

  const [branch, sha, status, diffStat] = await Promise.all([
    execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    execGit(['rev-parse', 'HEAD'], cwd),
    execGit(['status', '--porcelain'], cwd),
    execGit(['diff', '--stat', 'HEAD'], cwd)
  ]);

  const currentSha = sha.ok ? sha.stdout.trim() || undefined : undefined;

  return {
    enabled: true,
    insideWorkTree: true,
    changesSince: await collectChangesSince(cwd, args.sinceSha),
    branch: branch.ok ? branch.stdout.trim() || undefined : undefined,
    sha: currentSha,
    isDirty: status.ok ? status.stdout.trim().length > 0 : undefined,
    changedFiles: status.ok ? parsePorcelain(status.stdout) : undefined,
    diffStat: diffStat.ok ? diffStat.stdout.trim().slice(0, MAX_DIFFSTAT_CHARS) || undefined : undefined
  };
}

/**
 * Diffs the working tree against an earlier commit.
 *
 * Returns nothing when there is no earlier commit to compare with, when it is
 * the commit we are already on with no local changes, or when git cannot
 * resolve it - a commit from a branch that has since been rebased away is a
 * normal thing to encounter, not an error worth surfacing.
 */
async function collectChangesSince(
  cwd: string,
  sinceSha: string | undefined
): Promise<GitEvidence['changesSince']> {
  if (!sinceSha) {
    return undefined;
  }

  const exists = await execGit(['cat-file', '-e', `${sinceSha}^{commit}`], cwd);
  if (!exists.ok) {
    return undefined;
  }

  const [names, stat, count] = await Promise.all([
    execGit(['diff', '--name-only', sinceSha], cwd),
    execGit(['diff', '--stat', sinceSha], cwd),
    execGit(['rev-list', '--count', `${sinceSha}..HEAD`], cwd)
  ]);

  const files = names.ok
    ? names.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, MAX_CHANGED_FILES)
    : [];

  const commits = count.ok ? Number(count.stdout.trim()) : undefined;

  // Nothing changed and no commits landed: there is nothing to report.
  if (!files.length && !commits) {
    return undefined;
  }

  return {
    sha: sinceSha,
    files,
    diffStat: stat.ok ? stat.stdout.trim().slice(0, MAX_DIFFSTAT_CHARS) || undefined : undefined,
    commits: Number.isFinite(commits) ? commits : undefined
  };
}

/**
 * Parses `git status --porcelain` output.
 *
 * The format is `XY <path>`, where a rename is `R  old -> new`. Quoted paths
 * appear when a name contains unusual bytes; the quotes are stripped so the
 * value matches what the error parsers produce.
 */
export function parsePorcelain(stdout: string): string[] {
  const files: string[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (line.length < 4) {
      continue;
    }

    let filePath = line.slice(3).trim();
    if (!filePath) {
      continue;
    }

    // Renames and copies list both sides; the new path is the interesting one.
    const arrow = filePath.indexOf(' -> ');
    if (arrow !== -1) {
      filePath = filePath.slice(arrow + 4).trim();
    }

    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1);
    }

    files.push(filePath);
    if (files.length >= MAX_CHANGED_FILES) {
      break;
    }
  }

  return files;
}
