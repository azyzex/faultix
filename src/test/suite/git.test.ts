/**
 * Tests against a real git repository.
 *
 * These spawn git rather than mocking it. The module exists to report what git
 * says, so a mock would only assert that the mock was configured correctly —
 * and the porcelain and diff formats are exactly the kind of detail a mock
 * gets subtly wrong.
 *
 * Each test builds a throwaway repository in the temp directory. The whole
 * suite runs in well under a second.
 */

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { collectGitEvidence, parsePorcelain } from '../../analyze/git';
import { execGit } from '../../analyze/gitExec';

/** True when git is usable here; the suite is skipped otherwise. */
function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = gitAvailable();

const repos: string[] = [];

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Creates a repository with one commit, and returns its path. */
function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faultix-git-'));
  repos.push(root);

  run(root, 'init', '-q');
  run(root, 'config', 'user.email', 'test@example.com');
  run(root, 'config', 'user.name', 'Test');
  run(root, 'config', 'commit.gpgsign', 'false');

  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  run(root, 'add', '.');
  run(root, 'commit', '-q', '-m', 'first');

  return root;
}

suite('git/parsePorcelain', () => {
  test('reads modified and added entries', () => {
    assert.deepStrictEqual(parsePorcelain(' M src/a.ts\nA  src/b.ts'), ['src/a.ts', 'src/b.ts']);
  });

  test('takes the new name of a rename', () => {
    assert.deepStrictEqual(parsePorcelain('R  old.ts -> new.ts'), ['new.ts']);
  });

  test('strips the quoting git applies to unusual names', () => {
    assert.deepStrictEqual(parsePorcelain(' M "src/a file.ts"'), ['src/a file.ts']);
  });

  test('ignores blank and truncated lines', () => {
    assert.deepStrictEqual(parsePorcelain('\n M a.ts\n\nXY\n'), ['a.ts']);
  });

  test('handles empty input', () => {
    assert.deepStrictEqual(parsePorcelain(''), []);
  });

  test('caps a very large change set', () => {
    const many = Array.from({ length: 500 }, (_, i) => ` M file${i}.ts`).join('\n');
    assert.strictEqual(parsePorcelain(many).length, 100);
  });
});

suite('git/execGit', function () {
  if (!HAS_GIT) {
    test('skipped: git is not installed', () => assert.ok(true));
    return;
  }

  test('reports success and stdout', async () => {
    const repo = makeRepo();
    const result = await execGit(['rev-parse', '--is-inside-work-tree'], repo);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.stdout.trim(), 'true');
  });

  test('reports failure without throwing', async () => {
    const repo = makeRepo();
    const result = await execGit(['rev-parse', 'not-a-real-ref'], repo);
    assert.strictEqual(result.ok, false);
  });

  test('reports failure for a directory that is not a repository', async () => {
    const result = await execGit(['rev-parse', '--is-inside-work-tree'], os.tmpdir());
    assert.strictEqual(result.ok, false);
  });
});

suite('git/collectGitEvidence', function () {
  if (!HAS_GIT) {
    test('skipped: git is not installed', () => assert.ok(true));
    return;
  }

  suiteTeardown(() => {
    for (const repo of repos) {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('reports nothing when disabled', async () => {
    const evidence = await collectGitEvidence({ enabled: false, workspaceRoot: makeRepo() });
    assert.strictEqual(evidence.enabled, false);
    assert.strictEqual(evidence.insideWorkTree, false);
  });

  test('reports nothing without a workspace', async () => {
    const evidence = await collectGitEvidence({ enabled: true, workspaceRoot: undefined });
    assert.strictEqual(evidence.insideWorkTree, false);
  });

  test('reports a directory that is not a repository', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'faultix-plain-'));
    const evidence = await collectGitEvidence({ enabled: true, workspaceRoot: plain });
    assert.strictEqual(evidence.insideWorkTree, false);
    fs.rmSync(plain, { recursive: true, force: true });
  });

  test('reports branch, commit and a clean tree', async () => {
    const repo = makeRepo();
    const evidence = await collectGitEvidence({ enabled: true, workspaceRoot: repo });

    assert.strictEqual(evidence.insideWorkTree, true);
    assert.ok(evidence.branch, 'a branch name');
    assert.match(evidence.sha ?? '', /^[0-9a-f]{40}$/, 'a full commit sha');
    assert.strictEqual(evidence.isDirty, false);
    assert.deepStrictEqual(evidence.changedFiles, []);
  });

  test('reports a dirty tree and which files changed', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');

    const evidence = await collectGitEvidence({ enabled: true, workspaceRoot: repo });

    assert.strictEqual(evidence.isDirty, true);
    assert.ok(evidence.changedFiles?.includes('a.txt'));
    assert.ok(evidence.changedFiles?.includes('b.txt'), 'untracked files count as changes');
  });

  test('says nothing about changes when no commit was asked for', async () => {
    const evidence = await collectGitEvidence({ enabled: true, workspaceRoot: makeRepo() });
    assert.strictEqual(evidence.changesSince, undefined);
  });

  test('diffs against an earlier commit', async () => {
    const repo = makeRepo();
    const firstSha = run(repo, 'rev-parse', 'HEAD');

    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(repo, 'c.txt'), 'three\n');
    run(repo, 'add', '.');
    run(repo, 'commit', '-q', '-m', 'second');

    const evidence = await collectGitEvidence({
      enabled: true,
      workspaceRoot: repo,
      sinceSha: firstSha
    });

    assert.ok(evidence.changesSince, 'expected a diff');
    assert.strictEqual(evidence.changesSince.sha, firstSha);
    assert.strictEqual(evidence.changesSince.commits, 1);
    assert.deepStrictEqual([...evidence.changesSince.files].sort(), ['a.txt', 'c.txt']);
    assert.ok(evidence.changesSince.diffStat);
  });

  test('includes uncommitted work in the diff', async () => {
    const repo = makeRepo();
    const firstSha = run(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'edited but not committed\n');

    const evidence = await collectGitEvidence({ enabled: true, workspaceRoot: repo, sinceSha: firstSha });

    assert.deepStrictEqual(evidence.changesSince?.files, ['a.txt']);
    assert.strictEqual(evidence.changesSince?.commits, 0, 'no commits landed');
  });

  test('reports nothing when the tree matches the commit asked about', async () => {
    const repo = makeRepo();
    const sha = run(repo, 'rev-parse', 'HEAD');
    const evidence = await collectGitEvidence({ enabled: true, workspaceRoot: repo, sinceSha: sha });
    assert.strictEqual(evidence.changesSince, undefined, 'nothing changed, so there is nothing to say');
  });

  test('degrades quietly when the commit cannot be resolved', async () => {
    // A branch that has since been rebased away is normal, not an error.
    const evidence = await collectGitEvidence({
      enabled: true,
      workspaceRoot: makeRepo(),
      sinceSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    });
    assert.strictEqual(evidence.changesSince, undefined);
  });
});
