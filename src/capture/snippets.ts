/**
 * Code context extraction.
 *
 * Naming a file and a line is not enough for an agent to act: it still has to
 * go and read the code. Embedding the few lines around the failure removes a
 * round trip and, in practice, is what turns a brief into something you can
 * paste into a chat and get a correct answer from.
 *
 * Reads are best effort. A file that has been deleted, is binary, or is too
 * large simply produces no snippet rather than an error.
 */

import * as fs from 'fs';
import { redact } from '../privacy/redact';
import type { CodeSnippet } from '../output/templates';

export interface SnippetOptions {
  /** Lines of context to include on each side of the focus line. */
  contextLines?: number;
  /** Skip files larger than this; they are almost never hand-written. */
  maxFileBytes?: number;
  /** Hard cap on characters per line, to survive minified files. */
  maxLineLength?: number;
  /** Scrub secrets from the snippet before it is embedded. */
  redactSecrets?: boolean;
}

const DEFAULTS: Required<SnippetOptions> = {
  contextLines: 6,
  maxFileBytes: 2 * 1024 * 1024,
  maxLineLength: 500,
  redactSecrets: true
};

export interface SnippetRequest {
  /** Absolute path to read. */
  absolutePath: string;
  /** Workspace-relative path to display. */
  displayPath: string;
  /** 1-based line to centre on. */
  line?: number;
}

/**
 * Reads the lines around a location. Returns undefined when the file cannot be
 * used, which callers treat as "no snippet" rather than as a failure.
 */
export function readSnippet(request: SnippetRequest, options: SnippetOptions = {}): CodeSnippet | undefined {
  const config = { ...DEFAULTS, ...options };

  if (request.line === undefined || request.line < 1) {
    return undefined;
  }

  let content: string;
  try {
    const stat = fs.statSync(request.absolutePath);
    if (!stat.isFile() || stat.size > config.maxFileBytes) {
      return undefined;
    }
    content = fs.readFileSync(request.absolutePath, 'utf8');
  } catch {
    return undefined;
  }

  // A NUL byte in the first chunk is the cheapest reliable binary test.
  if (content.slice(0, 4096).includes(String.fromCharCode(0))) {
    return undefined;
  }

  const all = content.replace(/\r\n/g, '\n').split('\n');
  if (request.line > all.length) {
    return undefined;
  }

  const startLine = Math.max(1, request.line - config.contextLines);
  const endLine = Math.min(all.length, request.line + config.contextLines);

  let truncated = false;
  const lines = all.slice(startLine - 1, endLine).map((line) => {
    if (line.length > config.maxLineLength) {
      truncated = true;
      return line.slice(0, config.maxLineLength) + ' ...';
    }
    return line;
  });

  const rendered = config.redactSecrets ? lines.map((line) => redact(line, { anonymizeHome: false })) : lines;

  return {
    file: request.displayPath,
    absolutePath: request.absolutePath,
    startLine,
    focusLine: request.line,
    lines: rendered,
    truncated
  };
}

/**
 * Reads snippets for the most relevant locations, one per file, capped so a
 * brief with twenty suspects does not turn into a source dump.
 */
export function readSnippets(
  requests: SnippetRequest[],
  limit = 3,
  options: SnippetOptions = {}
): CodeSnippet[] {
  const seen = new Set<string>();
  const snippets: CodeSnippet[] = [];

  for (const request of requests) {
    const key = request.absolutePath.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const snippet = readSnippet(request, options);
    if (snippet) {
      snippets.push(snippet);
    }
    if (snippets.length >= limit) {
      break;
    }
  }

  return snippets;
}
