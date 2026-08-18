/**
 * Path helpers.
 *
 * Two jobs: deciding whether a path is interesting enough to surface as a
 * suspect, and making sure a workspace-relative setting cannot be used to
 * write outside the workspace. Both are pure and platform-aware without
 * depending on `vscode`.
 */

import * as path from 'path';

/**
 * Directories whose contents are almost never the cause of a local failure.
 * A stack frame in `node_modules` points at the library, not at your bug.
 */
export const DEFAULT_IGNORED_SEGMENTS: readonly string[] = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'vendor',
  'target',
  // 'bin' is deliberately absent: Rust keeps real sources in src/bin, and many
  // repositories put hand-written scripts there. 'obj' is safe to ignore.
  'obj',
  '__pycache__',
  '.venv',
  'venv',
  'site-packages',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.gradle',
  '.idea',
  '.vscode-test'
];

/** Normalizes separators so comparisons work the same on every platform. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Splits a path into lowercase segments. Case folding is deliberate: Windows
 * and macOS are case-insensitive, and a `Node_Modules` directory should still
 * be ignored.
 */
export function segments(p: string): string[] {
  return toPosix(p)
    .split('/')
    .filter((s) => s.length > 0 && s !== '.')
    .map((s) => s.toLowerCase());
}

/** True when any path segment matches a well-known vendored/build directory. */
export function isIgnoredPath(p: string, extraSegments: readonly string[] = []): boolean {
  const ignored = new Set([...DEFAULT_IGNORED_SEGMENTS, ...extraSegments].map((s) => s.toLowerCase()));
  return segments(p).some((segment) => ignored.has(segment));
}

/** True when a path looks like a test file rather than production code. */
export function isTestPath(p: string): boolean {
  const posix = toPosix(p).toLowerCase();
  return (
    /(^|\/)(tests?|__tests__|spec|specs|e2e)(\/|$)/.test(posix) ||
    /\.(test|spec)\.[a-z0-9]+$/.test(posix) ||
    /(^|\/)test_[^/]+\.py$/.test(posix) ||
    /(^|\/)[^/]+_test\.(go|py|rb)$/.test(posix)
  );
}

/** True when a path is a lockfile, generated bundle, or minified artifact. */
export function isGeneratedPath(p: string): boolean {
  const base = toPosix(p).toLowerCase().split('/').pop() ?? '';
  return (
    /\.(min|bundle|chunk)\.[a-z0-9]+$/.test(base) ||
    /\.map$/.test(base) ||
    /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|cargo\.lock|gemfile\.lock|composer\.lock)$/.test(base) ||
    /\.(d\.ts)$/.test(base)
  );
}

/**
 * Resolves a workspace-relative path and refuses anything that would escape
 * the workspace root. Used for the configurable output directory: a value like
 * `../../Windows/System32` must not be honoured.
 */
export function resolveWithinRoot(root: string, relative: string): string | undefined {
  if (!root) {
    return undefined;
  }

  const trimmed = relative.trim();
  if (!trimmed) {
    return undefined;
  }

  // Absolute paths and Windows drive/UNC prefixes are never workspace-relative.
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed) || /^[\\/]{2}/.test(trimmed)) {
    return undefined;
  }

  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, trimmed);

  if (!isWithin(resolvedRoot, candidate)) {
    return undefined;
  }

  return candidate;
}

/** True when `child` is the same as, or nested inside, `parent`. */
export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative === '') {
    return true;
  }
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Makes a path relative to the workspace root for display. Falls back to the
 * basename for paths outside the workspace so briefs never leak a full home
 * directory path into a document the user may paste publicly.
 */
export function displayPath(root: string | undefined, target: string): string {
  if (!root) {
    return toPosix(target);
  }
  if (isWithin(root, target)) {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    return toPosix(relative || '.');
  }
  return toPosix(path.basename(target));
}

/** File extension without the dot, lowercased. Empty string when there is none. */
export function extensionOf(p: string): string {
  const ext = path.extname(toPosix(p));
  return ext.startsWith('.') ? ext.slice(1).toLowerCase() : '';
}

/** Source extensions Faultix will follow when resolving references. */
export const SOURCE_EXTENSIONS: readonly string[] = [
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'pyi', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'cs', 'fs',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx', 'm', 'mm',
  'rb', 'php', 'lua', 'pl', 'swift', 'dart', 'ex', 'exs', 'erl', 'clj',
  'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'env',
  'sql', 'graphql', 'gql', 'proto', 'md', 'mdx',
  'html', 'css', 'scss', 'sass', 'less',
  'dockerfile', 'makefile', 'gradle', 'tf'
];

/** True when the extension is one Faultix treats as source worth ranking. */
export function hasSourceExtension(p: string): boolean {
  const base = toPosix(p).toLowerCase().split('/').pop() ?? '';
  if (base === 'dockerfile' || base === 'makefile' || base === 'rakefile' || base === 'gemfile') {
    return true;
  }
  return SOURCE_EXTENSIONS.includes(extensionOf(p));
}
