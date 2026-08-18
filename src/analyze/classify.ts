/**
 * Command classification.
 *
 * Turns a raw command line (or a VS Code task name) into the two labels that
 * drive the rest of the pipeline: what kind of failure this is, and which tool
 * produced the output. The tool hint in particular selects which error parser
 * gets first pick at the terminal text.
 *
 * Pure: no `vscode` import, so it is unit testable in plain Node.
 */

export type IncidentKind =
  | 'build'
  | 'test'
  | 'runtime'
  | 'lint'
  | 'typecheck'
  | 'packageinstall'
  | 'debug-session'
  | 'unknown';

export type ToolHint =
  | 'tsc'
  | 'eslint'
  | 'prettier'
  | 'vite'
  | 'webpack'
  | 'next'
  | 'jest'
  | 'vitest'
  | 'mocha'
  | 'playwright'
  | 'cypress'
  | 'pytest'
  | 'python'
  | 'ruff'
  | 'mypy'
  | 'pip'
  | 'go'
  | 'cargo'
  | 'rustc'
  | 'gradle'
  | 'maven'
  | 'dotnet'
  | 'msbuild'
  | 'gcc'
  | 'clang'
  | 'make'
  | 'cmake'
  | 'docker'
  | 'kubectl'
  | 'terraform'
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'deno'
  | 'node'
  | 'php'
  | 'composer'
  | 'ruby'
  | 'bundler'
  | 'rspec'
  | 'lua'
  | 'powershell'
  | 'cmd'
  | 'shell'
  | 'git';

/**
 * Ordered most-specific-first. A command like `npm run test` must resolve to
 * the test runner rather than to npm, so runner patterns are checked before
 * package-manager patterns.
 */
const TOOL_PATTERNS: Array<[RegExp, ToolHint]> = [
  [/\bvitest\b/, 'vitest'],
  [/\bjest\b/, 'jest'],
  [/\bmocha\b/, 'mocha'],
  [/\bplaywright\b/, 'playwright'],
  [/\bcypress\b/, 'cypress'],
  [/\bpytest\b|\bpy\.test\b/, 'pytest'],
  [/\brspec\b/, 'rspec'],
  [/\btsc\b|\btypescript\b/, 'tsc'],
  [/\beslint\b/, 'eslint'],
  [/\bprettier\b/, 'prettier'],
  [/\bruff\b/, 'ruff'],
  [/\bmypy\b/, 'mypy'],
  [/\bnext\b/, 'next'],
  [/\bvite\b/, 'vite'],
  [/\bwebpack\b/, 'webpack'],
  [/\bcargo\b/, 'cargo'],
  [/\brustc\b/, 'rustc'],
  [/\bgo\s+(build|test|run|vet|install)\b|\bgofmt\b/, 'go'],
  [/\bgradlew?\b/, 'gradle'],
  [/\bmvn\b|\bmaven\b/, 'maven'],
  [/\bdotnet\b/, 'dotnet'],
  [/\bmsbuild\b/, 'msbuild'],
  [/\bcmake\b/, 'cmake'],
  [/\bmake\b/, 'make'],
  [/\b(gcc|g\+\+|cc)\b/, 'gcc'],
  [/\b(clang|clang\+\+)\b/, 'clang'],
  [/\bdocker(-compose)?\b/, 'docker'],
  [/\bkubectl\b/, 'kubectl'],
  [/\bterraform\b/, 'terraform'],
  [/\bcomposer\b/, 'composer'],
  [/\bphp\b/, 'php'],
  [/\bbundle\b/, 'bundler'],
  [/\bruby\b|\brake\b/, 'ruby'],
  [/\blua\b/, 'lua'],
  [/\bpip3?\b/, 'pip'],
  [/\bpython3?\b|\bpy\b/, 'python'],
  [/\bdeno\b/, 'deno'],
  [/\bbun\b/, 'bun'],
  [/\bpnpm\b/, 'pnpm'],
  [/\byarn\b/, 'yarn'],
  [/\bnpm\b|\bnpx\b/, 'npm'],
  [/\bnode\b/, 'node'],
  [/\bgit\b/, 'git'],
  [/\bpowershell\b|\bpwsh\b|\.ps1\b/, 'powershell'],
  [/\bcmd\b|\.(bat|cmd)\b/, 'cmd'],
  [/\bbash\b|\bsh\b|\bzsh\b|\.sh\b/, 'shell']
];

/**
 * Kind patterns, again most-specific-first. Install is checked before test
 * because `npm install --include=test` should still read as an install.
 */
const KIND_PATTERNS: Array<[RegExp, IncidentKind]> = [
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b/, 'packageinstall'],
  [/\bpip3?\s+install\b|\bpoetry\s+(add|install)\b|\bbundle\s+install\b/, 'packageinstall'],
  [/\bcargo\s+(add|fetch)\b|\bgo\s+(get|mod\s+download)\b|\bcomposer\s+(install|require)\b/, 'packageinstall'],
  [
    /\b(test|tests|jest|vitest|mocha|pytest|rspec|playwright|cypress)\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bmvn\s+test\b/,
    'test'
  ],
  [/\b(lint|eslint|ruff|pylint|flake8|clippy|rubocop|stylelint)\b/, 'lint'],
  [/\b(tsc|typecheck|type-check|mypy|pyright)\b/, 'typecheck'],
  [
    /\b(build|compile|bundle|dist|webpack|rollup|esbuild)\b|\bcargo\s+build\b|\bgo\s+build\b|\bmake\b|\bcmake\b|\bgradlew?\b|\bmvn\b|\bdotnet\s+build\b|\bdocker\s+build\b/,
    'build'
  ],
  [
    /\b(start|serve|dev|run|exec|node|python3?|ruby|php|lua|deno|bun)\b|\.(js|mjs|cjs|ts|py|rb|php|lua|sh|ps1|bat|cmd)\b/,
    'runtime'
  ]
];

/** Detects which tool a command line invokes. */
export function inferToolHint(commandLine: string): ToolHint | undefined {
  const normalized = normalizeForMatching(commandLine);
  for (const [pattern, hint] of TOOL_PATTERNS) {
    if (pattern.test(normalized)) {
      return hint;
    }
  }
  return undefined;
}

/** Classifies what sort of failure a command line represents. */
export function inferKindFromCommand(commandLine: string): IncidentKind {
  const normalized = normalizeForMatching(commandLine);
  for (const [pattern, kind] of KIND_PATTERNS) {
    if (pattern.test(normalized)) {
      return kind;
    }
  }
  return 'unknown';
}

/**
 * Classifies a VS Code task by its display name. Task names are prose rather
 * than commands ("Node: syntax error (broken_syntax.js)"), so this is looser
 * than the command classifier and falls back to it.
 */
export function inferKindFromTaskName(name: string): IncidentKind {
  const normalized = normalizeForMatching(name);

  if (/\b(install|restore)\b/.test(normalized)) {
    return 'packageinstall';
  }
  if (/\b(tests?|specs?|jest|vitest|pytest|rspec|mocha)\b/.test(normalized)) {
    return 'test';
  }
  if (/\b(lint|eslint|pylint|ruff|rubocop|clippy)\b/.test(normalized)) {
    return 'lint';
  }
  if (/\b(typecheck|type-check|tsc|mypy|pyright)\b/.test(normalized)) {
    return 'typecheck';
  }
  if (/\b(builds?|compiles?|bundles?|watch)\b/.test(normalized)) {
    return 'build';
  }
  if (/\b(run|start|serve|exec|launch|debug)\b/.test(normalized)) {
    return 'runtime';
  }

  return inferKindFromCommand(name);
}

/**
 * Refines a kind using the output text once it is available. A command that
 * merely looked like `node x.js` is a runtime failure; one whose output is a
 * stack trace definitely is. Explicit non-unknown kinds are left alone unless
 * the output contradicts them strongly.
 */
export function refineKindFromOutput(kind: IncidentKind, output: string): IncidentKind {
  if (!output) {
    return kind;
  }
  const head = output.slice(0, 4000);

  if (kind !== 'unknown') {
    return kind;
  }
  if (/Traceback \(most recent call last\)|^\s+at .+:\d+:\d+/m.test(head)) {
    return 'runtime';
  }
  if (/error TS\d+|Type '.+' is not assignable/.test(head)) {
    return 'typecheck';
  }
  if (/\b\d+ (passing|failing|passed|failed)\b|AssertionError/i.test(head)) {
    return 'test';
  }
  if (/\b(syntax error|parse error|SyntaxError|unexpected token)\b/i.test(head)) {
    return 'build';
  }
  if (/npm ERR!|ERESOLVE|could not resolve dependency/i.test(head)) {
    return 'packageinstall';
  }

  return kind;
}

/**
 * Lowercases and neutralizes path separators so that
 * `C:\tools\Python311\python.exe` matches the same patterns as `python`.
 */
function normalizeForMatching(commandLine: string): string {
  return commandLine
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\.exe\b/g, '')
    .replace(/[/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Human-facing label for a kind, used in titles and the tree view. */
export function describeKind(kind: IncidentKind): string {
  switch (kind) {
    case 'build':
      return 'Build failure';
    case 'test':
      return 'Test failure';
    case 'runtime':
      return 'Runtime error';
    case 'lint':
      return 'Lint failure';
    case 'typecheck':
      return 'Type error';
    case 'packageinstall':
      return 'Dependency install failure';
    case 'debug-session':
      return 'Debug session failure';
    default:
      return 'Command failure';
  }
}
