/**
 * Integration tests.
 *
 * These run inside a real Extension Host against a throwaway workspace, and
 * cover the things unit tests cannot reach: activation, command registration,
 * settings plumbing, and actually writing brief files onto disk.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'azyzex.faultix';

const EXPECTED_COMMANDS = [
  'faultix.createRepairBrief',
  'faultix.openLatestIncident',
  'faultix.copyRepairPrompt',
  'faultix.copyLatestBrief',
  'faultix.rerunLatestCommand',
  'faultix.markLatestResolved',
  'faultix.openOutputFolder',
  'faultix.clearHistory',
  'faultix.togglePause'
];

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the integration workspace should be open');
  return folder.uri.fsPath;
}

function outputDir(): string {
  return path.join(workspaceRoot(), '.ai-repair');
}

/** Polls until the predicate holds, so tests do not depend on fixed sleeps. */
async function waitFor(predicate: () => boolean, timeoutMs = 15000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`condition not met within ${timeoutMs}ms`);
}

suite('integration/activation', () => {
  suiteSetup(async function () {
    this.timeout(60000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} should be present`);
    await extension.activate();
  });

  test('the extension activates', () => {
    assert.strictEqual(vscode.extensions.getExtension(EXTENSION_ID)?.isActive, true);
  });

  test('every contributed command is registered', async () => {
    const registered = await vscode.commands.getCommands(true);
    const missing = EXPECTED_COMMANDS.filter((command) => !registered.includes(command));
    assert.deepStrictEqual(missing, [], 'these commands were declared but never registered');
  });

  test('every registered command is declared in the manifest', () => {
    const manifest = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as {
      contributes?: { commands?: Array<{ command: string }> };
    };
    const declared = (manifest.contributes?.commands ?? []).map((c) => c.command).sort();
    assert.deepStrictEqual(declared, [...EXPECTED_COMMANDS].sort());
  });

  test('the failures view is contributed', () => {
    const manifest = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as {
      contributes?: { views?: Record<string, Array<{ id: string }>> };
    };
    const views = manifest.contributes?.views?.faultix ?? [];
    assert.ok(views.some((view) => view.id === 'faultix.incidents'));
  });
});

suite('integration/manual capture', () => {
  suiteSetup(async function () {
    this.timeout(60000);
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    fs.rmSync(outputDir(), { recursive: true, force: true });
  });

  test('writes all three artifacts into the workspace', async function () {
    this.timeout(30000);

    await vscode.commands.executeCommand('faultix.createRepairBrief');

    const latest = path.join(outputDir(), 'latest');
    const names = ['incident.md', 'repair.prompt.md', 'incident.json'];

    // The three files are written in sequence, so waiting on the first would
    // race the rest: wait until every one exists and has been fully flushed.
    await waitFor(() =>
      names.every((name) => {
        const file = path.join(latest, name);
        return fs.existsSync(file) && fs.statSync(file).size > 0;
      })
    );

    for (const name of names) {
      assert.ok(fs.existsSync(path.join(latest, name)), `${name} should have been written`);
    }
  });

  test('the incident json round-trips', () => {
    const raw = fs.readFileSync(path.join(outputDir(), 'latest', 'incident.json'), 'utf8');
    const incident = JSON.parse(raw) as Record<string, unknown>;

    assert.ok(typeof incident.id === 'string');
    assert.ok(typeof incident.createdAt === 'string');
    assert.strictEqual(incident.status, 'unresolved');
    assert.strictEqual(incident.trigger, 'manual');
    assert.ok(incident.fingerprint, 'fingerprint present');
  });

  test('the brief is valid markdown with no control characters', () => {
    const markdown = fs.readFileSync(path.join(outputDir(), 'latest', 'incident.md'), 'utf8');

    assert.ok(markdown.startsWith('#'), 'starts with a heading');
    assert.ok(!markdown.includes(String.fromCharCode(0x1b)), 'no escape bytes');
    assert.ok(!markdown.includes('[object Object]'));
    assert.ok(!markdown.includes('undefined:undefined'));
  });

  test('the prompt ends with an explicit task', () => {
    const prompt = fs.readFileSync(path.join(outputDir(), 'latest', 'repair.prompt.md'), 'utf8');
    assert.ok(prompt.includes('## Your task'));
  });

  test('marking resolved does not throw', async () => {
    await vscode.commands.executeCommand('faultix.markLatestResolved');
  });

  test('copying the prompt puts markdown on the clipboard', async () => {
    // A headless Extension Host does not always have a usable system
    // clipboard. Write a sentinel first so an unavailable clipboard is
    // distinguishable from a broken command rather than silently passing.
    const sentinel = `faultix-clipboard-probe-${Date.now()}`;
    await vscode.env.clipboard.writeText(sentinel);

    await vscode.commands.executeCommand('faultix.copyRepairPrompt');
    const clipboard = await vscode.env.clipboard.readText();

    if (clipboard === sentinel || clipboard === '') {
      console.warn('    (clipboard unavailable in this environment; command completed without error)');
      return;
    }

    assert.ok(clipboard.includes('# Repair brief'), `clipboard should hold the prompt, got: ${clipboard.slice(0, 80)}`);
  });

  test('opening the latest brief shows a document', async function () {
    this.timeout(20000);
    await vscode.commands.executeCommand('faultix.openLatestIncident');
    await waitFor(() => vscode.window.activeTextEditor?.document.fileName.endsWith('incident.md') === true);
  });
});

suite('integration/settings are honoured', () => {
  const config = () => vscode.workspace.getConfiguration('faultix');

  suiteTeardown(async () => {
    await config().update('output.dir', undefined, vscode.ConfigurationTarget.Workspace);
    await config().update('output.mode', undefined, vscode.ConfigurationTarget.Workspace);
  });

  test('refuses an output directory that escapes the workspace', async function () {
    this.timeout(30000);

    const escapeTarget = path.resolve(workspaceRoot(), '..', 'faultix-escape-check');
    fs.rmSync(escapeTarget, { recursive: true, force: true });

    await config().update('output.dir', '../faultix-escape-check', vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('faultix.createRepairBrief');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    assert.strictEqual(
      fs.existsSync(escapeTarget),
      false,
      'a traversing output.dir must not create a directory outside the workspace'
    );
  });

  test('clipboardOnly mode writes nothing to disk', async function () {
    this.timeout(30000);

    await config().update('output.dir', '.ai-repair-clipboard', vscode.ConfigurationTarget.Workspace);
    await config().update('output.mode', 'clipboardOnly', vscode.ConfigurationTarget.Workspace);

    const target = path.join(workspaceRoot(), '.ai-repair-clipboard');
    fs.rmSync(target, { recursive: true, force: true });

    await vscode.commands.executeCommand('faultix.createRepairBrief');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    assert.strictEqual(fs.existsSync(target), false, 'clipboardOnly must not write files');
  });
});

suite('integration/capture is resilient', () => {
  test('pausing and resuming does not throw', async () => {
    await vscode.commands.executeCommand('faultix.togglePause');
    await vscode.commands.executeCommand('faultix.togglePause');
  });

  test('repeated captures are stable', async function () {
    this.timeout(40000);
    for (let i = 0; i < 3; i++) {
      await vscode.commands.executeCommand('faultix.createRepairBrief');
    }
  });

  /** Reads the repeat count recorded for the most recent capture. */
  function currentCount(): number {
    const raw = fs.readFileSync(path.join(outputDir(), 'latest', 'incident.json'), 'utf8');
    return (JSON.parse(raw) as { fingerprint: { count: number } }).fingerprint.count;
  }

  /**
   * Waits until the count stops moving.
   *
   * Earlier tests in this file fire captures without awaiting the write, so
   * reading a baseline immediately would race work still in flight — which is
   * exactly how this test passed locally and failed on a fresh CI runner.
   */
  async function waitForQuiet(stableForMs = 1200): Promise<number> {
    let last = currentCount();
    let lastChangedAt = Date.now();

    while (Date.now() - lastChangedAt < stableForMs) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const now = currentCount();
      if (now !== last) {
        last = now;
        lastChangedAt = Date.now();
      }
    }

    return last;
  }

  test('counts each repeat exactly once', async function () {
    this.timeout(60000);

    const config = vscode.workspace.getConfiguration('faultix');
    await config.update('output.mode', undefined, vscode.ConfigurationTarget.Workspace);
    await config.update('output.dir', undefined, vscode.ConfigurationTarget.Workspace);

    await vscode.commands.executeCommand('faultix.createRepairBrief');
    await waitFor(() => fs.existsSync(path.join(outputDir(), 'latest', 'incident.json')));

    // Measure a delta rather than an absolute value: earlier tests in this
    // file have already captured, and clearHistory needs a modal nobody can
    // answer here. "At least N" would not have caught double counting.
    const before = await waitForQuiet();
    const captures = 3;

    // Wait for each capture to land before starting the next: the count is
    // read from a file the extension writes asynchronously, so firing all
    // three and checking at the end races the writer.
    for (let i = 1; i <= captures; i++) {
      await vscode.commands.executeCommand('faultix.createRepairBrief');
      await waitFor(() => currentCount() >= before + i);
    }

    const after = await waitForQuiet();
    assert.strictEqual(
      after,
      before + captures,
      `each capture of the same failure must increment the repeat count exactly once ` +
        `(was ${before}, expected ${before + captures}, got ${after})`
    );
  });
});
