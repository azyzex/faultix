#!/usr/bin/env node
/**
 * faultix-mcp — exposes this workspace's failure history to a coding agent.
 *
 * Speaks the Model Context Protocol over stdio, so Claude Code, Cursor and
 * anything else that speaks MCP can ask what Faultix already knows instead of
 * waiting for a human to paste it.
 *
 * Read-only by construction: it opens the files the extension wrote and
 * nothing else. No commands are run and nothing is modified.
 *
 * Usage:
 *   node out/mcp/server.js [workspace-root]
 *
 * Configure it in Claude Code with:
 *   claude mcp add faultix -- node /path/to/faultix/out/mcp/server.js /path/to/project
 */

import * as path from 'path';
import * as readline from 'readline';
import { handleMessage, parseMessage, errorResponse, ErrorCode } from './protocol';
import type { JsonRpcResponse, ServerInfo } from './protocol';
import { createToolRegistry } from './tools';
import { FaultixStore } from './store';

const SERVER_INFO: ServerInfo = { name: 'faultix', version: '0.3.0' };

interface Args {
  root: string;
  outputDir: string;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let outputDir = '.ai-repair';

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output-dir') {
      outputDir = argv[++i] ?? outputDir;
      continue;
    }
    positional.push(argv[i] as string);
  }

  return { root: path.resolve(positional[0] ?? process.cwd()), outputDir };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const store = new FaultixStore({ root: args.root, outputDir: args.outputDir });
  const tools = createToolRegistry({ store });

  // stdout carries protocol traffic exclusively; anything else must go to
  // stderr or it corrupts the stream.
  const write = (response: JsonRpcResponse): void => {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  };

  process.stderr.write(`faultix-mcp reading ${store.directory}\n`);
  if (!store.exists()) {
    process.stderr.write('  (nothing captured there yet; tools will say so rather than fail)\n');
  }

  const input = readline.createInterface({ input: process.stdin, terminal: false });

  // Responses are written in the order requests arrived, so a slow tool call
  // cannot reorder the stream.
  let queue: Promise<void> = Promise.resolve();

  input.on('line', (line) => {
    queue = queue.then(async () => {
      let message;
      try {
        message = parseMessage(line);
      } catch {
        write(errorResponse(null, ErrorCode.ParseError, 'Invalid JSON'));
        return;
      }

      if (!message) {
        return;
      }

      try {
        const response = await handleMessage(message, tools, SERVER_INFO);
        if (response) {
          write(response);
        }
      } catch (error) {
        write(
          errorResponse(
            message.id ?? null,
            ErrorCode.InternalError,
            error instanceof Error ? error.message : String(error)
          )
        );
      }
    });
  });

  input.on('close', () => {
    void queue.then(() => process.exit(0));
  });
}

main();
