/**
 * Run ledger persistence.
 *
 * The ledger lives in the workspace at `<outputDir>/runs.json` rather than in
 * extension storage, because the MCP server reads it. An agent asking "have I
 * seen this failure before" needs a file it can open; a path inside VS Code's
 * private storage would be unreachable.
 *
 * Writes are debounced. A build loop can finish several commands a second, and
 * rewriting the file each time would be wasteful for data nobody reads until
 * the next failure.
 */

import * as vscode from 'vscode';
import { appendRun, coerceLedger, commandKeyOf, emptyLedger } from '../analyze/runLedger';
import type { RunLedger, RunRecord } from '../analyze/runLedger';
import type { GitEvidence } from '../analyze/git';
import type { Incident } from './models';
import { getConfig } from './config';

const LEDGER_FILE = 'runs.json';
const FLUSH_DELAY_MS = 750;

export interface RunStoreDeps {
  /** Resolves the configured output directory, or undefined when unusable. */
  outputDir: () => vscode.Uri | undefined;
  output: vscode.LogOutputChannel;
}

export class RunStore implements vscode.Disposable {
  private ledger: RunLedger | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private dirty = false;

  public constructor(private readonly deps: RunStoreDeps) {}

  public dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    // A pending write is worth completing on shutdown; losing the last few
    // runs would quietly break repeat counting.
    void this.flush();
  }

  private get ledgerUri(): vscode.Uri | undefined {
    const root = this.deps.outputDir();
    return root ? vscode.Uri.joinPath(root, LEDGER_FILE) : undefined;
  }

  public async read(): Promise<RunLedger> {
    if (this.ledger) {
      return this.ledger;
    }

    const uri = this.ledgerUri;
    if (!uri) {
      this.ledger = emptyLedger();
      return this.ledger;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.ledger = coerceLedger(JSON.parse(Buffer.from(bytes).toString('utf8')));
    } catch {
      // Missing or corrupt: start clean rather than block capture.
      this.ledger = emptyLedger();
    }

    return this.ledger;
  }

  /** Records a run and schedules a write. */
  public async record(run: RunRecord): Promise<RunLedger> {
    const config = getConfig();
    const ledger = await this.read();

    this.ledger = appendRun(ledger, run, config.maxRuns);
    this.dirty = true;
    this.scheduleFlush();

    return this.ledger;
  }

  /** Builds a record for a command that succeeded. */
  public static successRun(args: {
    commandLine: string;
    durationMs?: number;
    git?: GitEvidence;
    at?: Date;
  }): RunRecord {
    return {
      at: (args.at ?? new Date()).toISOString(),
      commandKey: commandKeyOf(args.commandLine),
      commandLine: args.commandLine,
      ok: true,
      exitCode: 0,
      durationMs: args.durationMs,
      gitSha: args.git?.sha,
      gitDirty: args.git?.isDirty,
      changedFiles: args.git?.changedFiles
    };
  }

  /** Builds a record from a captured failure. */
  public static failureRun(incident: Incident): RunRecord {
    const commandLine = incident.command?.commandLine ?? incident.title;

    return {
      at: incident.createdAt,
      commandKey: commandKeyOf(commandLine),
      commandLine,
      ok: false,
      exitCode: incident.command?.exitCode,
      durationMs: incident.command?.durationMs,
      gitSha: incident.git?.sha,
      gitDirty: incident.git?.isDirty,
      changedFiles: incident.git?.changedFiles,
      signature: incident.fingerprint.signature,
      incidentId: incident.id,
      summary: incident.summary
    };
  }

  public async clear(): Promise<void> {
    this.ledger = emptyLedger();
    this.dirty = true;
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, FLUSH_DELAY_MS);
  }

  public async flush(): Promise<void> {
    if (!this.dirty || !this.ledger) {
      return;
    }

    const uri = this.ledgerUri;
    if (!uri) {
      return;
    }

    try {
      const root = this.deps.outputDir();
      if (root) {
        await vscode.workspace.fs.createDirectory(root);
      }
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(this.ledger, null, 2), 'utf8'));
      this.dirty = false;
    } catch (error) {
      this.deps.output.warn(
        `Could not write the Faultix run ledger: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
