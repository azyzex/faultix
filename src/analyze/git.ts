import * as vscode from 'vscode';
import type { GitEvidence } from '../core/models';
import { execGit } from './gitExec';

export async function collectGitEvidence(args: {
  enabled: boolean;
  workspaceFolder: vscode.Uri | undefined;
}): Promise<GitEvidence> {
  if (!args.enabled || !args.workspaceFolder) {
    return { enabled: args.enabled, insideWorkTree: false };
  }

  const cwd = args.workspaceFolder.fsPath;

  const inside = await execGit(['rev-parse', '--is-inside-work-tree'], cwd);
  const insideWorkTree = inside.ok && inside.stdout.trim() === 'true';
  if (!insideWorkTree) {
    return { enabled: true, insideWorkTree: false };
  }

  const branch = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const status = await execGit(['status', '--porcelain'], cwd);
  const changedFiles = status.ok
    ? status.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => l.slice(3).trim())
        .filter(Boolean)
    : undefined;

  const diffStat = await execGit(['diff', '--stat', '--', '.'], cwd);

  return {
    enabled: true,
    insideWorkTree: true,
    branch: branch.ok ? branch.stdout.trim() : undefined,
    isDirty: status.ok ? status.stdout.trim().length > 0 : undefined,
    changedFiles,
    diffStat: diffStat.ok ? diffStat.stdout.trim().slice(0, 4000) : undefined
  };
}
