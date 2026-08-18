import * as path from 'path';
import * as vscode from 'vscode';

export function inferToolHint(commandLine: string): string | undefined {
  const c = commandLine.toLowerCase();
  const tools = [
    ['tsc', 'tsc'],
    ['eslint', 'eslint'],
    ['vite', 'vite'],
    ['next', 'next'],
    ['jest', 'jest'],
    ['vitest', 'vitest'],
    ['pytest', 'pytest'],
    ['go test', 'go'],
    ['cargo', 'cargo'],
    ['gradle', 'gradle'],
    ['mvn', 'maven'],
    ['maven', 'maven'],
    ['npm', 'npm'],
    ['pnpm', 'pnpm'],
    ['yarn', 'yarn']
  ] as const;

  for (const [needle, label] of tools) {
    if (c.includes(needle)) {
      return label;
    }
  }
  return undefined;
}

export function inferKindFromCommand(commandLine: string):
  | 'build'
  | 'test'
  | 'runtime'
  | 'lint'
  | 'typecheck'
  | 'packageinstall'
  | 'unknown' {
  const c = commandLine.toLowerCase();
  if (/(npm|pnpm|yarn)\s+(i|install|add)\b/.test(c)) {
    return 'packageinstall';
  }
  if (/\b(test|vitest|jest|pytest|go test|cargo test)\b/.test(c)) {
    return 'test';
  }
  if (/\b(lint|eslint|ruff)\b/.test(c)) {
    return 'lint';
  }
  if (/\b(tsc|typecheck)\b/.test(c)) {
    return 'typecheck';
  }
  if (/\b(build|vite build|next build|gradle|mvn)\b/.test(c)) {
    return 'build';
  }
  return 'unknown';
}

const fileLinePatterns: RegExp[] = [
  // /path/to/file.ts:12:34
  /((?:[A-Za-z]:)?[\\/][^\s:>\)\]]+\.(?:ts|tsx|js|jsx|py|go|rs|java|json|yaml|yml|toml|md)):(\d+)(?::(\d+))?/g,
  // relative/path/file.ts:12:34
  /([^\s:>\)\]]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|cpp|c|rb|php|lua|json|yaml|yml|toml|xml|md)):(\d+)(?::(\d+))?/g,
  // file.ts(12,34)
  /([^\s\(\)]+\.(?:ts|tsx|js|jsx|py|go|rs|java))\((\d+),(\d+)\)/g
];

export function extractFileRefs(
  text: string,
  context: vscode.ExtensionContext
): Array<{ uri: vscode.Uri; line?: number; col?: number; raw: string }> {
  void context;
  const results: Array<{ uri: vscode.Uri; line?: number; col?: number; raw: string }> = [];

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;

  for (const re of fileLinePatterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const raw = match[0];
      const filePathRaw = match[1];
      const line = match[2] ? Number(match[2]) : undefined;
      const col = match[3] ? Number(match[3]) : undefined;

      const uri = toWorkspaceUri(filePathRaw, workspaceFolder);
      if (!uri) {
        continue;
      }
      results.push({ uri, line, col, raw });
      if (results.length >= 50) {
        return results;
      }
    }
  }

  return results;
}

const commandFilePatterns: RegExp[] = [
  // Quoted or unquoted file-like args with common extensions
  /(?:^|\s)("[^"\r\n]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|cpp|c|rb|php|lua|json|yaml|yml|toml|xml|md|bat|cmd|ps1|sh)"|'[^'\r\n]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|cpp|c|rb|php|lua|json|yaml|yml|toml|xml|md|bat|cmd|ps1|sh)'|[^\s"']+\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|cpp|c|rb|php|lua|json|yaml|yml|toml|xml|md|bat|cmd|ps1|sh))(?=\s|$)/gi
];

export function extractCommandFileRefs(
  commandLine: string,
  context: vscode.ExtensionContext
): Array<{ uri: vscode.Uri; raw: string }> {
  void context;
  const results: Array<{ uri: vscode.Uri; raw: string }> = [];
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceFolder) {
    return results;
  }

  for (const re of commandFilePatterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(commandLine))) {
      const token = match[1];
      if (!token) {
        continue;
      }

      const unquoted = token.replace(/^['"]|['"]$/g, '').replace(/[\]\)\],;]+$/g, '');
      const uri = toWorkspaceUri(unquoted, workspaceFolder);
      if (!uri) {
        continue;
      }

      results.push({ uri, raw: `commandLine: ${unquoted}` });
      if (results.length >= 20) {
        return results;
      }
    }
  }

  return results;
}

function toWorkspaceUri(filePathRaw: string, workspaceFolder: vscode.Uri | undefined): vscode.Uri | undefined {
  try {
    // Absolute path
    if (path.isAbsolute(filePathRaw)) {
      return vscode.Uri.file(filePathRaw);
    }

    // Relative path: resolve against workspace
    if (workspaceFolder) {
      const joined = path.join(workspaceFolder.fsPath, filePathRaw);
      return vscode.Uri.file(joined);
    }
  } catch {
    // ignore
  }
  return undefined;
}
