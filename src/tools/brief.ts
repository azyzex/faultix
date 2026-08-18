#!/usr/bin/env node
/**
 * faultix-brief — run a command and print the brief Faultix would produce.
 *
 * This is the same pipeline the extension runs, minus the editor: the only
 * things it cannot supply are open diagnostics and the workspace name. It
 * exists for three reasons:
 *
 *   1. Seeing what a brief looks like for your own failures without launching
 *      an Extension Host.
 *   2. Debugging extraction against a real tool: `--json` shows every matcher
 *      that fired and what it produced.
 *   3. Recording new test fixtures: `--save <name>` writes the raw captured
 *      output into src/test/fixtures.
 *
 * Usage:
 *   node out/tools/brief.js "python app.py"
 *   node out/tools/brief.js --prompt "npm test"
 *   node out/tools/brief.js --json "cargo build"
 *   node out/tools/brief.js --save my-tool "make"
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { collectGitEvidence } from '../analyze/git';
import { analyzeFailure, DEFAULT_ANALYSIS_OPTIONS } from '../analyze/pipeline';
import { buildIncidentMarkdown, buildRepairPrompt } from '../output/templates';

interface Args {
  command: string;
  format: 'brief' | 'prompt' | 'json';
  cwd: string;
  saveFixture?: string;
  noRedact: boolean;
}

function parseArgs(argv: string[]): Args | undefined {
  const args: Args = {
    command: '',
    format: 'brief',
    cwd: process.cwd(),
    noRedact: false
  };

  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--prompt':
        args.format = 'prompt';
        break;
      case '--json':
        args.format = 'json';
        break;
      case '--no-redact':
        args.noRedact = true;
        break;
      case '--cwd':
        args.cwd = argv[++i] ?? process.cwd();
        break;
      case '--save':
        args.saveFixture = argv[++i];
        break;
      case '-h':
      case '--help':
        return undefined;
      default:
        rest.push(arg);
    }
  }

  args.command = rest.join(' ').trim();
  return args.command ? args : undefined;
}

function usage(): void {
  process.stdout.write(
    [
      'faultix-brief - run a command and print the repair brief Faultix would produce.',
      '',
      'Usage:',
      '  node out/tools/brief.js [options] <command...>',
      '',
      'Options:',
      '  --prompt          Print the agent prompt instead of the human brief',
      '  --json            Print the full incident as JSON',
      '  --cwd <dir>       Run the command in this directory',
      '  --save <name>     Also save the raw output as a test fixture',
      '  --no-redact       Do not scrub secrets (use only on output you trust)',
      '',
      'Examples:',
      '  node out/tools/brief.js "python app.py"',
      '  node out/tools/brief.js --prompt --cwd ../faultixTEST "node node-js/runtime_error.js"',
      ''
    ].join('\n')
  );
}

/** Runs the command through a shell, capturing stdout and stderr interleaved. */
function run(command: string, cwd: string): Promise<{ output: string; exitCode: number; durationMs: number }> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, { cwd, shell: true });

    let output = '';
    const append = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
    };

    child.stdout.on('data', append);
    child.stderr.on('data', append);

    child.on('error', (error) => {
      output += `\n${error.message}\n`;
      resolve({ output, exitCode: 127, durationMs: Date.now() - startedAt });
    });

    child.on('close', (code) => {
      resolve({ output, exitCode: code ?? 0, durationMs: Date.now() - startedAt });
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    usage();
    process.exitCode = 1;
    return;
  }

  const cwd = path.resolve(args.cwd);
  if (!fs.existsSync(cwd)) {
    process.stderr.write(`No such directory: ${cwd}\n`);
    process.exitCode = 1;
    return;
  }

  process.stderr.write(`> ${args.command}\n`);
  const result = await run(args.command, cwd);
  process.stderr.write(`  exit ${result.exitCode} in ${result.durationMs}ms\n\n`);

  if (args.saveFixture) {
    const target = path.resolve(__dirname, '..', '..', 'src', 'test', 'fixtures', `${args.saveFixture}.txt`);
    fs.writeFileSync(target, result.output, 'utf8');
    process.stderr.write(`  saved fixture: ${path.relative(process.cwd(), target)}\n\n`);
  }

  const git = await collectGitEvidence({ enabled: true, workspaceRoot: cwd });

  const incident = analyzeFailure({
    trigger: 'manual',
    options: { ...DEFAULT_ANALYSIS_OPTIONS, redactSecrets: !args.noRedact },
    rawOutput: result.output,
    commandLine: args.command,
    cwd,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    workspaceRoot: cwd,
    workspaceName: path.basename(cwd),
    git
  });

  switch (args.format) {
    case 'prompt':
      process.stdout.write(buildRepairPrompt(incident));
      break;
    case 'json':
      process.stdout.write(`${JSON.stringify(incident, null, 2)}\n`);
      break;
    default:
      process.stdout.write(buildIncidentMarkdown(incident));
  }

  // Exit non-zero when the analyzed command failed, so this composes in a
  // shell pipeline the same way the command it wrapped would.
  process.exitCode = result.exitCode === 0 ? 0 : 1;
}

void main();
