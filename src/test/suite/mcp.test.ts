import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ErrorCode,
  handleMessage,
  negotiateVersion,
  parseMessage,
  SUPPORTED_PROTOCOL_VERSIONS
} from '../../mcp/protocol';
import type { JsonRpcRequest, ToolRegistry } from '../../mcp/protocol';
import { FaultixStore, scoreIncidentMatch } from '../../mcp/store';
import { createToolRegistry, TOOL_DEFINITIONS } from '../../mcp/tools';
import type { Incident } from '../../core/models';
import type { RunLedger, RunRecord } from '../../analyze/runLedger';

const INFO = { name: 'faultix', version: 'test' };

function request(method: string, params?: Record<string, never> | object, id: number | null = 1): JsonRpcRequest {
  return { jsonrpc: '2.0', id: id ?? undefined, method, params: params as never };
}

/** A registry that records what it was asked, for dispatch tests. */
function stubRegistry(): ToolRegistry & { calls: Array<{ name: string; args: unknown }> } {
  const calls: Array<{ name: string; args: unknown }> = [];
  return {
    calls,
    list: () => [{ name: 'demo', description: 'demo tool', inputSchema: { type: 'object' } }],
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'explode') {
        throw new Error('tool blew up');
      }
      return { text: `called ${name}` };
    }
  };
}

suite('mcp/protocol framing', () => {
  test('parses a request', () => {
    const message = parseMessage('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    assert.strictEqual(message?.method, 'ping');
  });

  test('ignores a blank line', () => {
    assert.strictEqual(parseMessage('   '), undefined);
  });

  test('throws on malformed JSON, so the caller can report a parse error', () => {
    assert.throws(() => parseMessage('{not json'));
  });
});

suite('mcp/protocol version negotiation', () => {
  test('echoes a version it implements', () => {
    assert.strictEqual(negotiateVersion('2024-11-05'), '2024-11-05');
  });

  test('offers its newest when asked for something unknown', () => {
    assert.strictEqual(negotiateVersion('1999-01-01'), SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  test('copes with a missing or non-string version', () => {
    assert.strictEqual(negotiateVersion(undefined), SUPPORTED_PROTOCOL_VERSIONS[0]);
    assert.strictEqual(negotiateVersion(42), SUPPORTED_PROTOCOL_VERSIONS[0]);
  });
});

suite('mcp/protocol dispatch', () => {
  test('initialize advertises tools and identifies the server', async () => {
    const response = await handleMessage(
      request('initialize', { protocolVersion: '2025-06-18' }),
      stubRegistry(),
      INFO
    );

    const result = response?.result as Record<string, never>;
    assert.strictEqual(response?.id, 1);
    assert.strictEqual((result as unknown as { protocolVersion: string }).protocolVersion, '2025-06-18');
    assert.ok((result as unknown as { capabilities: { tools: unknown } }).capabilities.tools);
    assert.strictEqual((result as unknown as { serverInfo: { name: string } }).serverInfo.name, 'faultix');
  });

  test('the initialized notification gets no reply', async () => {
    const notification: JsonRpcRequest = { jsonrpc: '2.0', method: 'notifications/initialized' };
    assert.strictEqual(await handleMessage(notification, stubRegistry(), INFO), undefined);
  });

  test('ping answers with an empty result', async () => {
    const response = await handleMessage(request('ping'), stubRegistry(), INFO);
    assert.deepStrictEqual(response?.result, {});
  });

  test('tools/list returns the registry', async () => {
    const response = await handleMessage(request('tools/list'), stubRegistry(), INFO);
    const tools = (response?.result as unknown as { tools: Array<{ name: string }> }).tools;
    assert.strictEqual(tools[0].name, 'demo');
  });

  test('tools/call forwards name and arguments', async () => {
    const registry = stubRegistry();
    await handleMessage(request('tools/call', { name: 'demo', arguments: { a: 1 } }), registry, INFO);
    assert.deepStrictEqual(registry.calls[0], { name: 'demo', args: { a: 1 } });
  });

  test('tools/call tolerates missing arguments', async () => {
    const registry = stubRegistry();
    await handleMessage(request('tools/call', { name: 'demo' }), registry, INFO);
    assert.deepStrictEqual(registry.calls[0].args, {});
  });

  test('tools/call without a name is an invalid-params error', async () => {
    const response = await handleMessage(request('tools/call', {}), stubRegistry(), INFO);
    assert.strictEqual(response?.error?.code, ErrorCode.InvalidParams);
  });

  test('a throwing tool becomes a tool error, not a transport error', async () => {
    // The model can read a tool error and try something else; a protocol
    // failure just breaks the session.
    const response = await handleMessage(request('tools/call', { name: 'explode' }), stubRegistry(), INFO);
    assert.strictEqual(response?.error, undefined);
    assert.strictEqual((response?.result as unknown as { isError: boolean }).isError, true);
    assert.ok(JSON.stringify(response?.result).includes('tool blew up'));
  });

  test('an unknown method is method-not-found', async () => {
    const response = await handleMessage(request('nope'), stubRegistry(), INFO);
    assert.strictEqual(response?.error?.code, ErrorCode.MethodNotFound);
  });

  test('an unknown notification is silently ignored', async () => {
    const notification: JsonRpcRequest = { jsonrpc: '2.0', method: 'notifications/whatever' };
    assert.strictEqual(await handleMessage(notification, stubRegistry(), INFO), undefined);
  });

  test('a wrong jsonrpc version is rejected', async () => {
    const response = await handleMessage(
      { jsonrpc: '1.0', id: 1, method: 'ping' },
      stubRegistry(),
      INFO
    );
    assert.strictEqual(response?.error?.code, ErrorCode.InvalidRequest);
  });

  test('every response carries the request id', async () => {
    const response = await handleMessage(request('ping', {}, 77), stubRegistry(), INFO);
    assert.strictEqual(response?.id, 77);
  });
});

// --- Store and tools --------------------------------------------------------

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: '2026-01-01T00-00-00-000Z_sig1',
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'test',
    status: 'unresolved',
    trigger: 'terminal',
    title: 'Command failed (1): npm test',
    summary: 'AssertionError: expected 2 to be 3 (src/sum.test.ts:4)',
    command: { commandLine: 'npm test', exitCode: 1 },
    primaryError: { severity: 'error', message: 'expected 2 to be 3', file: 'src/sum.test.ts', line: 4 },
    errors: [{ severity: 'error', message: 'expected 2 to be 3', file: 'src/sum.test.ts', line: 4 }],
    suspects: [{ file: 'src/sum.test.ts', score: 100, reasons: ['Named by the primary error'] }],
    fingerprint: { signature: 'sig1', count: 1, firstSeen: 'a', lastSeen: 'b' },
    ...overrides
  };
}

/** Builds a throwaway workspace containing what the extension would have written. */
function makeWorkspace(options: { incident?: Incident; ledger?: RunLedger; archived?: Incident[] } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faultix-mcp-'));
  const base = path.join(root, '.ai-repair');
  fs.mkdirSync(path.join(base, 'latest'), { recursive: true });
  fs.mkdirSync(path.join(base, 'history'), { recursive: true });

  if (options.incident) {
    fs.writeFileSync(path.join(base, 'latest', 'incident.json'), JSON.stringify(options.incident));
    fs.writeFileSync(path.join(base, 'latest', 'incident.md'), `# ${options.incident.summary}\n`);
    fs.writeFileSync(path.join(base, 'latest', 'repair.prompt.md'), `# Repair brief: ${options.incident.summary}\n`);
  }
  if (options.ledger) {
    fs.writeFileSync(path.join(base, 'runs.json'), JSON.stringify(options.ledger));
  }
  for (const [index, archived] of (options.archived ?? []).entries()) {
    fs.writeFileSync(path.join(base, 'history', `2026-01-0${index + 1}_x.json`), JSON.stringify(archived));
  }

  return root;
}

function run(partial: Partial<RunRecord>): RunRecord {
  return {
    at: '2026-01-01T00:00:00.000Z',
    commandKey: 'npm test',
    commandLine: 'npm test',
    ok: true,
    ...partial
  };
}

const NOW = new Date('2026-01-02T00:00:00.000Z');

async function callTool(root: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const registry = createToolRegistry({ store: new FaultixStore({ root }), now: () => NOW });
  const result = await registry.call(name, args as never);
  return result.text;
}

suite('mcp/store', () => {
  test('reports the directory it reads, so misconfiguration is obvious', () => {
    const store = new FaultixStore({ root: 'C:/repo' });
    assert.ok(store.directory.endsWith(path.join('repo', '.ai-repair')));
  });

  test('honours a custom output directory', () => {
    const store = new FaultixStore({ root: 'C:/repo', outputDir: '.faultix' });
    assert.ok(store.directory.endsWith('.faultix'));
  });

  test('reports a workspace with nothing captured', () => {
    assert.strictEqual(new FaultixStore({ root: os.tmpdir() }).exists(), false);
  });

  test('reads the latest incident', () => {
    const root = makeWorkspace({ incident: incident() });
    assert.strictEqual(new FaultixStore({ root }).latestIncident()?.fingerprint.signature, 'sig1');
  });

  test('returns an empty ledger when there is no runs.json', () => {
    const root = makeWorkspace({ incident: incident() });
    assert.deepStrictEqual(new FaultixStore({ root }).ledger().runs, []);
  });

  test('survives a corrupt file rather than throwing', () => {
    const root = makeWorkspace({ incident: incident() });
    fs.writeFileSync(path.join(root, '.ai-repair', 'runs.json'), '{ truncated');
    assert.deepStrictEqual(new FaultixStore({ root }).ledger().runs, []);
  });

  test('lists archived incidents newest first', () => {
    const root = makeWorkspace({
      archived: [incident({ id: 'older' }), incident({ id: 'newer' })]
    });
    const archived = new FaultixStore({ root }).archivedIncidents();
    assert.strictEqual(archived[0].id, 'newer', 'timestamped filenames sort chronologically');
  });
});

suite('mcp/store scoring', () => {
  test('matches on the summary', () => {
    assert.ok(scoreIncidentMatch(incident(), 'AssertionError') > 0);
  });

  test('requires every term to appear', () => {
    assert.strictEqual(scoreIncidentMatch(incident(), 'AssertionError unrelatedword'), 0);
  });

  test('weighs a summary match above a buried one', () => {
    const buried = incident({ summary: 'something else', terminalExcerpt: 'AssertionError somewhere' });
    assert.ok(scoreIncidentMatch(incident(), 'AssertionError') > scoreIncidentMatch(buried, 'AssertionError'));
  });

  test('ignores an empty query', () => {
    assert.strictEqual(scoreIncidentMatch(incident(), '   '), 0);
  });
});

suite('mcp/tools', () => {
  test('every declared tool has a handler', async () => {
    const root = makeWorkspace({ incident: incident() });
    for (const definition of TOOL_DEFINITIONS) {
      const text = await callTool(root, definition.name);
      assert.ok(text.length > 0, `${definition.name} produced nothing`);
      assert.ok(!text.startsWith('Unknown tool'), `${definition.name} has no handler`);
    }
  });

  test('every tool description explains when to use it', () => {
    for (const definition of TOOL_DEFINITIONS) {
      assert.ok(definition.description.length > 60, `${definition.name} needs a fuller description`);
      assert.ok(/use this/i.test(definition.description), `${definition.name} should say when to reach for it`);
    }
  });

  test('an unknown tool is reported as an error', async () => {
    const registry = createToolRegistry({ store: new FaultixStore({ root: os.tmpdir() }) });
    const result = await registry.call('nope', {});
    assert.strictEqual(result.isError, true);
  });

  test('says so plainly when nothing has been captured', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'faultix-empty-'));
    const text = await callTool(empty, 'faultix_latest_failure');
    assert.ok(text.includes('has not captured anything'));
    assert.ok(text.includes('.ai-repair'), 'names the directory it looked in');
  });

  test('returns the brief, the prompt or the raw incident', async () => {
    const root = makeWorkspace({ incident: incident() });
    assert.ok((await callTool(root, 'faultix_latest_failure', { format: 'brief' })).startsWith('# AssertionError'));
    assert.ok((await callTool(root, 'faultix_latest_failure', { format: 'prompt' })).startsWith('# Repair brief'));
    assert.ok(JSON.parse(await callTool(root, 'faultix_latest_failure', { format: 'json' })).fingerprint);
  });

  test('search finds a past failure and says whether it was fixed', async () => {
    const root = makeWorkspace({
      archived: [incident()],
      ledger: {
        version: 1,
        runs: [
          run({ at: '2026-01-01T02:00:00.000Z', ok: true, changedFiles: ['src/sum.ts'] }),
          run({ at: '2026-01-01T01:00:00.000Z', ok: false, signature: 'sig1', changedFiles: ['src/sum.ts'] })
        ]
      }
    });

    const text = await callTool(root, 'faultix_search_failures', { query: 'AssertionError' });
    assert.ok(text.includes('Was fixed'), text);
    assert.ok(text.includes('src/sum.ts'), 'names what was being edited');
  });

  test('search requires a query', async () => {
    const root = makeWorkspace({ incident: incident() });
    assert.ok((await callTool(root, 'faultix_search_failures')).includes('Provide a "query"'));
  });

  test('search reports no matches without pretending', async () => {
    const root = makeWorkspace({ archived: [incident()] });
    assert.ok((await callTool(root, 'faultix_search_failures', { query: 'zzzznothing' })).includes('No past failure'));
  });

  test('history explains a prior fix and where it came from', async () => {
    const root = makeWorkspace({
      incident: incident(),
      ledger: {
        version: 1,
        runs: [
          run({ at: '2026-01-01T02:00:00.000Z', ok: true, changedFiles: ['src/sum.ts'] }),
          run({ at: '2026-01-01T01:00:00.000Z', ok: false, signature: 'sig1', changedFiles: ['src/sum.ts'] })
        ]
      }
    });

    const text = await callTool(root, 'faultix_failure_history', { signature: 'sig1' });
    assert.ok(text.includes('It was fixed'));
    assert.ok(text.includes('src/sum.ts'));
    assert.ok(text.includes('not a certainty'), 'is honest that it is a heuristic');
  });

  test('history is clear when a failure was never fixed', async () => {
    const root = makeWorkspace({
      incident: incident(),
      ledger: { version: 1, runs: [run({ ok: false, signature: 'sig1' })] }
    });
    const text = await callTool(root, 'faultix_failure_history', { signature: 'sig1' });
    assert.ok(text.includes('never been recorded as fixed'));
  });

  test('flaky detection explains why a disagreement matters', async () => {
    const root = makeWorkspace({
      ledger: {
        version: 1,
        runs: [
          run({ at: '2026-01-01T02:00:00.000Z', ok: true, gitSha: 'aaa111', gitDirty: false }),
          run({ at: '2026-01-01T01:00:00.000Z', ok: false, gitSha: 'aaa111', gitDirty: false, signature: 'sig1' })
        ]
      }
    });

    const text = await callTool(root, 'faultix_flaky_commands');
    assert.ok(text.includes('npm test'));
    assert.ok(text.includes('The code did not change'), 'says what the finding means');
  });

  test('flaky detection says nothing when nothing is flaky', async () => {
    const root = makeWorkspace({ ledger: { version: 1, runs: [run({ ok: true })] } });
    assert.ok((await callTool(root, 'faultix_flaky_commands')).includes('nothing looks flaky'));
  });

  test('command stats render a table', async () => {
    const root = makeWorkspace({
      ledger: { version: 1, runs: [run({ ok: true }), run({ ok: false, signature: 'sig1' })] }
    });
    const text = await callTool(root, 'faultix_command_stats');
    assert.ok(text.includes('| Command |'));
    assert.ok(text.includes('50%'));
  });

  test('recent failures list newest first with their fingerprints', async () => {
    const root = makeWorkspace({
      ledger: {
        version: 1,
        runs: [
          run({ at: '2026-01-01T05:00:00.000Z', ok: false, signature: 'newer', summary: 'newer failure' }),
          run({ at: '2026-01-01T01:00:00.000Z', ok: false, signature: 'older', summary: 'older failure' })
        ]
      }
    });

    const text = await callTool(root, 'faultix_recent_failures');
    assert.ok(text.indexOf('newer failure') < text.indexOf('older failure'));
    assert.ok(text.includes('newer'), 'includes the fingerprint');
  });

  test('ages are rendered in human terms', async () => {
    const root = makeWorkspace({
      ledger: { version: 1, runs: [run({ at: '2026-01-01T22:00:00.000Z', ok: false, signature: 's', summary: 'x' })] }
    });
    assert.ok((await callTool(root, 'faultix_recent_failures')).includes('hours ago'));
  });
});

suite('mcp/relative ages', () => {
  test('does not claim a future timestamp happened just now', async () => {
    // Clock skew, or a ledger written on another machine.
    const root = makeWorkspace({
      ledger: {
        version: 1,
        runs: [run({ at: '2027-06-01T00:00:00.000Z', ok: false, signature: 's', summary: 'from the future' })]
      }
    });

    const text = await callTool(root, 'faultix_recent_failures');
    assert.ok(!text.includes('just now'), text);
    assert.ok(text.includes('2027-06-01'), 'falls back to the timestamp itself');
  });

  test('renders a recent failure as minutes ago', async () => {
    const root = makeWorkspace({
      ledger: {
        version: 1,
        runs: [run({ at: '2026-01-01T23:30:00.000Z', ok: false, signature: 's', summary: 'x' })]
      }
    });
    assert.ok((await callTool(root, 'faultix_recent_failures')).includes('minutes ago'));
  });
});
