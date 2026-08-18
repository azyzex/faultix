/**
 * The tools Faultix exposes to an agent.
 *
 * These are chosen around one idea: an agent starts every session cold and
 * only sees the command it just ran. It does not know this failure has
 * happened six times, that you fixed it last Tuesday by editing one file, or
 * that this test disagrees with itself at the same commit. Faultix does, and
 * these are the questions that get that across.
 *
 * Output is markdown rather than JSON. A model reads it directly, and a
 * paragraph explaining what a number means is worth more than the number.
 */

import {
  allCommandStats,
  commandKeyOf,
  detectFlakyCommands,
  findAllResolutions,
  findResolution,
  occurrencesOf,
  statsForCommand
} from '../analyze/runLedger';
import { buildIncidentMarkdown, buildRepairPrompt } from '../output/templates';
import type { JsonValue, ToolDefinition, ToolRegistry, ToolResult } from './protocol';
import { FaultixStore, scoreIncidentMatch } from './store';

const DEFAULT_LIMIT = 10;

function text(body: string): ToolResult {
  return { text: body };
}

function problem(body: string): ToolResult {
  return { text: body, isError: true };
}

function asNumber(value: JsonValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function relativeAge(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return iso;
  }

  const minutes = Math.round((now.getTime() - then) / 60000);

  // A timestamp ahead of the clock means skew, or a record written on another
  // machine. Reporting "just now" would be a confident falsehood, so fall back
  // to the timestamp itself.
  if (minutes < -1) {
    return `at ${iso}`;
  }
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  return `${Math.round(hours / 24)} days ago`;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'faultix_latest_failure',
    description:
      'Get the most recent build, test or runtime failure captured in this workspace, as a repair brief: the root cause, the code around it, and the files worth opening first. Use this when the user refers to an error without pasting it, or says something like "fix the last failure".',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['brief', 'prompt', 'json'],
          description: 'brief (default) is human-readable; prompt is action-oriented; json is the raw incident.'
        }
      }
    }
  },
  {
    name: 'faultix_search_failures',
    description:
      'Search past failures in this workspace by error text, file name or command. Use this before debugging to check whether this exact problem has been seen and solved before.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for, e.g. "ENOENT package.json" or "TS2345".' },
        limit: { type: 'number', description: 'Maximum results, default 10.' }
      },
      required: ['query']
    }
  },
  {
    name: 'faultix_failure_history',
    description:
      'Ask what is known about a specific failure: how often it has occurred, whether it was ever fixed, and which files were being edited when it went away. Use this before debugging anything that might be recurring — it is the cross-session memory an agent does not otherwise have, and a prior fix is usually the fastest route to the current one.',
    inputSchema: {
      type: 'object',
      properties: {
        signature: { type: 'string', description: 'Failure fingerprint, as shown in a brief.' },
        command: { type: 'string', description: 'Alternatively, a command such as "npm test".' }
      }
    }
  },
  {
    name: 'faultix_flaky_commands',
    description:
      'List commands that have both passed and failed. When a command disagreed with itself at the same commit with a clean working tree, the code did not change between those runs, so the failure is flakiness, a race or an unstable environment rather than a fault in the logic. Use this before changing code to chase an intermittent test failure.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'faultix_command_stats',
    description:
      'Pass and failure rates for recorded commands, including when each last passed. Use this to answer "what changed since this last worked" or "is this suite reliable".',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Optional command to narrow to, e.g. "npm test".' }
      }
    }
  },
  {
    name: 'faultix_recent_failures',
    description:
      'List recent failures in this workspace, newest first, with what each one was. Use this to get oriented before deciding what to work on.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Maximum results, default 10.' } }
    }
  }
];

export interface ToolContext {
  store: FaultixStore;
  /** Injectable so "2 hours ago" is deterministic in tests. */
  now?: () => Date;
}

export function createToolRegistry(context: ToolContext): ToolRegistry {
  const now = (): Date => (context.now ? context.now() : new Date());

  // Values are optional because a lookup by name can miss, which is exactly
  // the case the guard below handles.
  const handlers: Record<string, ((args: Record<string, JsonValue>) => ToolResult) | undefined> = {
    faultix_latest_failure: (args) => latestFailure(context.store, asString(args.format) ?? 'brief'),
    faultix_search_failures: (args) =>
      searchFailures(context.store, asString(args.query), asNumber(args.limit, DEFAULT_LIMIT), now()),
    faultix_failure_history: (args) =>
      failureHistory(context.store, asString(args.signature), asString(args.command), now()),
    faultix_flaky_commands: () => flakyCommands(context.store),
    faultix_command_stats: (args) => commandStats(context.store, asString(args.command)),
    faultix_recent_failures: (args) => recentFailures(context.store, asNumber(args.limit, DEFAULT_LIMIT), now())
  };

  return {
    list: () => TOOL_DEFINITIONS,
    call: async (name, args) => {
      const handler = handlers[name];
      if (!handler) {
        return problem(`Unknown tool: ${name}`);
      }
      return Promise.resolve(handler(args));
    }
  };
}

// --- Handlers ---------------------------------------------------------------

function noDataYet(store: FaultixStore): ToolResult {
  return problem(
    [
      `Faultix has not captured anything in this workspace yet (looked in ${store.directory}).`,
      '',
      'It records automatically when a command fails in the VS Code terminal. If the extension is not installed here, there is nothing to read.'
    ].join('\n')
  );
}

function latestFailure(store: FaultixStore, format: string): ToolResult {
  const incident = store.latestIncident();
  if (!incident) {
    return noDataYet(store);
  }

  if (format === 'json') {
    return text(JSON.stringify(incident, null, 2));
  }
  if (format === 'prompt') {
    return text(store.latestPromptMarkdown() ?? buildRepairPrompt(incident));
  }
  return text(store.latestBriefMarkdown() ?? buildIncidentMarkdown(incident));
}

function searchFailures(store: FaultixStore, query: string | undefined, limit: number, at: Date): ToolResult {
  if (!query) {
    return problem('Provide a "query" to search for, e.g. "ENOENT" or "src/db.ts".');
  }

  const incidents = store.archivedIncidents(200);
  const latest = store.latestIncident();
  if (latest && !incidents.some((candidate) => candidate.id === latest.id)) {
    incidents.unshift(latest);
  }

  const matches = incidents
    .map((incident) => ({ incident, score: scoreIncidentMatch(incident, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.incident.createdAt.localeCompare(a.incident.createdAt))
    .slice(0, limit);

  if (!matches.length) {
    return text(`No past failure in this workspace matches "${query}".`);
  }

  const ledger = store.ledger();
  const lines = [`${matches.length} past failure(s) matching "${query}":`, ''];

  for (const { incident } of matches) {
    lines.push(`## ${incident.summary ?? incident.title}`);
    lines.push('');
    lines.push(`- When: ${relativeAge(incident.createdAt, at)} (${incident.createdAt})`);
    if (incident.command?.commandLine) {
      lines.push(`- Command: \`${incident.command.commandLine}\``);
    }
    lines.push(`- Fingerprint: \`${incident.fingerprint.signature}\``);

    const resolution = findResolution(ledger, incident.fingerprint.signature);
    if (resolution) {
      const files = resolution.likelyFixedBy.slice(0, 5);
      lines.push(
        `- **Was fixed** ${relativeAge(resolution.fixedAt, at)}` +
          (files.length ? `, while editing: ${files.map((file) => `\`${file}\``).join(', ')}` : '')
      );
    } else {
      lines.push('- Never recorded as fixed.');
    }
    lines.push('');
  }

  return text(lines.join('\n').trimEnd());
}

function failureHistory(
  store: FaultixStore,
  signature: string | undefined,
  command: string | undefined,
  at: Date
): ToolResult {
  const ledger = store.ledger();

  if (!signature && !command) {
    const latest = store.latestIncident();
    if (!latest) {
      return noDataYet(store);
    }
    signature = latest.fingerprint.signature;
  }

  const lines: string[] = [];

  if (signature) {
    const occurrences = occurrencesOf(ledger, signature);
    lines.push(`# Failure \`${signature}\``, '');

    if (!occurrences.length) {
      lines.push('No recorded occurrences. It may predate run recording being enabled.');
    } else {
      // `at` is the honest accessor: unlike indexing, it is typed as possibly
      // undefined, so the guards below are checked rather than assumed.
      const newest = occurrences.at(0);
      const oldest = occurrences.at(-1);

      lines.push(`- Seen ${occurrences.length} time(s).`);
      if (oldest) {
        lines.push(`- First: ${relativeAge(oldest.at, at)} (${oldest.at}).`);
      }
      if (newest) {
        lines.push(`- Most recent: ${relativeAge(newest.at, at)} (${newest.at}).`);
        if (newest.summary) {
          lines.push(`- What it says: ${newest.summary}`);
        }
      }
    }

    const resolution = findResolution(ledger, signature);
    lines.push('');
    if (resolution) {
      lines.push(`## It was fixed ${relativeAge(resolution.fixedAt, at)}`, '');
      lines.push(`It took ${resolution.attempts} attempt(s).`);
      if (resolution.likelyFixedBy.length) {
        lines.push('', 'Files being edited when it went away:');
        for (const file of resolution.likelyFixedBy.slice(0, 10)) {
          lines.push(`- \`${file}\``);
        }
        lines.push('', 'That is a strong hint about where the fix lives, not a certainty.');
      }
      if (resolution.commitsInBetween) {
        lines.push('', 'Commits landed between the failure and the fix, so committed work is missing from that list.');
      }
    } else {
      lines.push('It has never been recorded as fixed, so there is no prior solution to reuse.');
    }
  }

  if (command) {
    const key = commandKeyOf(command);
    const stats = statsForCommand(ledger, key);
    lines.push('', `# Command \`${command}\``, '');
    if (!stats) {
      lines.push('No recorded runs.');
    } else {
      lines.push(`- ${stats.runs} run(s): ${stats.passes} passed, ${stats.failures} failed.`);
      if (stats.lastPassAt) {
        lines.push(`- Last passed ${relativeAge(stats.lastPassAt, at)}${stats.lastPassSha ? ` at \`${stats.lastPassSha.slice(0, 8)}\`` : ''}.`);
      } else {
        lines.push('- It has never passed since recording began.');
      }
    }
  }

  return text(lines.join('\n').trim());
}

function flakyCommands(store: FaultixStore): ToolResult {
  const flaky = detectFlakyCommands(store.ledger());

  if (!flaky.length) {
    return text('No command has been recorded both passing and failing, so nothing looks flaky.');
  }

  const lines = ['# Commands that disagreed with themselves', ''];

  for (const entry of flaky) {
    lines.push(`## \`${entry.commandLine}\``);
    lines.push('');
    lines.push(`- ${entry.passes} passed, ${entry.failures} failed.`);
    if (entry.confidence === 'high') {
      lines.push(
        `- **Same commit \`${(entry.conflictingSha ?? '').slice(0, 8)}\`, clean working tree, both outcomes.** ` +
          'The code did not change between those runs, so this is flakiness, a race, or an unstable environment - not a fault to fix in the logic.'
      );
    } else {
      lines.push(
        '- Disagreed at one commit, but the working tree was dirty, so an edit in between may explain it. Treat as a weak signal.'
      );
    }
    lines.push('');
  }

  return text(lines.join('\n').trimEnd());
}

function commandStats(store: FaultixStore, command: string | undefined): ToolResult {
  const ledger = store.ledger();

  const stats = command
    ? [statsForCommand(ledger, commandKeyOf(command))].filter((entry) => entry !== undefined)
    : allCommandStats(ledger);

  if (!stats.length) {
    return text(command ? `No recorded runs of \`${command}\`.` : 'No commands have been recorded yet.');
  }

  const lines = ['| Command | Runs | Passed | Failed | Pass rate |', '|---|---|---|---|---|'];
  for (const entry of stats.slice(0, 25)) {
    lines.push(
      `| \`${entry.commandLine}\` | ${entry.runs} | ${entry.passes} | ${entry.failures} | ${Math.round(entry.passRate * 100)}% |`
    );
  }

  const resolutions = findAllResolutions(ledger);
  if (resolutions.length) {
    lines.push('', `${resolutions.length} recorded failure(s) have been fixed. Ask faultix_failure_history for details.`);
  }

  return text(lines.join('\n'));
}

function recentFailures(store: FaultixStore, limit: number, at: Date): ToolResult {
  const failures = store.recentFailures(limit);

  if (!failures.length) {
    const latest = store.latestIncident();
    if (!latest) {
      return noDataYet(store);
    }
    return text(`Only one failure is on record: ${latest.summary ?? latest.title} (${latest.createdAt}).`);
  }

  const lines = ['# Recent failures', ''];
  for (const run of failures) {
    lines.push(`- ${relativeAge(run.at, at)} — ${run.summary ?? run.commandLine}`);
    lines.push(`  - \`${run.commandLine}\`${run.signature ? ` · fingerprint \`${run.signature}\`` : ''}`);
  }

  return text(lines.join('\n'));
}
