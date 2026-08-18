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
  isDirty?: boolean;
  /** Repository-relative paths with uncommitted changes. */
  changedFiles?: string[];
  diffStat?: string;
}

/** Cap on files listed, so a huge refactor does not swamp the brief. */
const MAX_CHANGED_FILES = 100;

/** Cap on diffstat characters kept. */
const MAX_DIFFSTAT_CHARS = 4000;

export async function collectGitEvidence(args: {
  enabled: boolean;
  workspaceRoot: string | undefined;
}): Promise<GitEvidence> {
  if (!args.enabled || !args.workspaceRoot) {
    return { enabled: args.enabled, insideWorkTree: false };
  }

  const cwd = args.workspaceRoot;

  const inside = await execGit(['rev-parse', '--is-inside-work-tree'], cwd);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { enabled: true, insideWorkTree: false };
  }

  const [branch, status, diffStat] = await Promise.all([
    execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    execGit(['status', '--porcelain'], cwd),
    execGit(['diff', '--stat', 'HEAD'], cwd)
  ]);

  return {
    enabled: true,
    insideWorkTree: true,
    branch: branch.ok ? branch.stdout.trim() || undefined : undefined,
    isDirty: status.ok ? status.stdout.trim().length > 0 : undefined,
    changedFiles: status.ok ? parsePorcelain(status.stdout) : undefined,
    diffStat: diffStat.ok ? diffStat.stdout.trim().slice(0, MAX_DIFFSTAT_CHARS) || undefined : undefined
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
