/**
 * Read-only access to what Faultix has written into a workspace.
 *
 * The MCP server never writes and never runs anything: it reads the brief
 * files and the run ledger the extension produced. That is deliberate — an
 * agent asking "have I seen this before" should not be able to change the
 * answer, and a read-only server is one a user can grant without thinking
 * hard about it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { coerceLedger, emptyLedger } from '../analyze/runLedger';
import type { RunLedger, RunRecord } from '../analyze/runLedger';
import type { Incident } from '../core/models';

export interface StoreOptions {
  /** Workspace root. */
  root: string;
  /** Output directory name, matching `faultix.output.dir`. */
  outputDir?: string;
}

export class FaultixStore {
  private readonly base: string;

  public constructor(private readonly options: StoreOptions) {
    this.base = path.resolve(options.root, options.outputDir ?? '.ai-repair');
  }

  /** Where the extension writes. Reported in errors so misconfiguration is obvious. */
  public get directory(): string {
    return this.base;
  }

  public exists(): boolean {
    try {
      return fs.statSync(this.base).isDirectory();
    } catch {
      return false;
    }
  }

  /** The most recent incident, or undefined when nothing has been captured. */
  public latestIncident(): Incident | undefined {
    return this.readJson<Incident>(path.join(this.base, 'latest', 'incident.json'));
  }

  public latestBriefMarkdown(): string | undefined {
    return this.readText(path.join(this.base, 'latest', 'incident.md'));
  }

  public latestPromptMarkdown(): string | undefined {
    return this.readText(path.join(this.base, 'latest', 'repair.prompt.md'));
  }

  public ledger(): RunLedger {
    const parsed = this.readJson<unknown>(path.join(this.base, 'runs.json'));
    return parsed === undefined ? emptyLedger() : coerceLedger(parsed);
  }

  /**
   * Archived incidents, newest first.
   *
   * Filenames start with a timestamp, so a reverse lexical sort is a
   * chronological one and no file needs opening to order them.
   */
  public archivedIncidents(limit = 50): Incident[] {
    const dir = path.join(this.base, 'history');

    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }

    return names
      .sort()
      .reverse()
      .slice(0, Math.max(0, limit))
      .map((name) => this.readJson<Incident>(path.join(dir, name)))
      .filter((incident): incident is Incident => incident !== undefined);
  }

  /** Failing runs from the ledger, newest first. */
  public recentFailures(limit = 20): RunRecord[] {
    return this.ledger()
      .runs.filter((run) => !run.ok)
      .slice(0, Math.max(0, limit));
  }

  private readText(file: string): string | undefined {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  }

  private readJson<T>(file: string): T | undefined {
    const text = this.readText(file);
    if (text === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      // A half-written file is possible if the extension is mid-capture.
      return undefined;
    }
  }
}

/**
 * Scores how well an incident matches a free-text query.
 *
 * Deliberately simple: every query term must appear somewhere in the incident's
 * searchable text, and matches in the summary count for more than matches
 * buried in the terminal excerpt. A real index would be overkill for a few
 * hundred local records.
 */
export function scoreIncidentMatch(incident: Incident, query: string): number {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1);

  if (!terms.length) {
    return 0;
  }

  const strong = [incident.summary, incident.title, incident.primaryError?.message, incident.primaryError?.file]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const weak = [
    ...(incident.errors ?? []).map((error) => `${error.message} ${error.file ?? ''}`),
    ...(incident.suspects ?? []).map((suspect) => suspect.file),
    incident.command?.commandLine ?? '',
    incident.terminalExcerpt ?? ''
  ]
    .join(' ')
    .toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (strong.includes(term)) {
      score += 10;
    } else if (weak.includes(term)) {
      score += 3;
    } else {
      // Every term has to appear somewhere, or this is not a match at all.
      return 0;
    }
  }

  return score;
}
