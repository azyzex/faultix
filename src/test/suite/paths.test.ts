import * as assert from 'assert';
import * as path from 'path';
import {
  displayPath,
  extensionOf,
  hasSourceExtension,
  isGeneratedPath,
  isIgnoredPath,
  isTestPath,
  isWithin,
  resolveWithinRoot,
  segments,
  toPosix
} from '../../analyze/paths';

suite('paths/toPosix', () => {
  test('converts Windows separators', () => {
    assert.strictEqual(toPosix('src\\a\\b.ts'), 'src/a/b.ts');
  });

  test('leaves posix paths alone', () => {
    assert.strictEqual(toPosix('src/a/b.ts'), 'src/a/b.ts');
  });
});

suite('paths/segments', () => {
  test('splits and lowercases', () => {
    assert.deepStrictEqual(segments('Src/Node_Modules/x.ts'), ['src', 'node_modules', 'x.ts']);
  });

  test('drops empty and dot segments', () => {
    assert.deepStrictEqual(segments('./a//b'), ['a', 'b']);
  });
});

suite('paths/isIgnoredPath', () => {
  const ignored = [
    'node_modules/react/index.js',
    'src/../node_modules/x.js',
    'project/dist/bundle.js',
    'out/extension.js',
    'coverage/lcov.info',
    '.git/config',
    'app/__pycache__/mod.pyc',
    'backend/.venv/lib/site-packages/flask/app.py',
    'rust/target/debug/build.rs',
    'java/.gradle/cache.bin'
  ];

  for (const p of ignored) {
    test(`ignores ${p}`, () => {
      assert.strictEqual(isIgnoredPath(p), true);
    });
  }

  const kept = ['src/index.ts', 'app/main.py', 'lib/util.go', 'src/bin/cli.rs'];
  for (const p of kept) {
    test(`keeps ${p}`, () => {
      assert.strictEqual(isIgnoredPath(p), false);
    });
  }

  test('is case insensitive', () => {
    assert.strictEqual(isIgnoredPath('Node_Modules/x.js'), true);
  });

  test('honours extra segments', () => {
    assert.strictEqual(isIgnoredPath('generated/x.ts', ['generated']), true);
  });

  test('does not match a partial segment', () => {
    assert.strictEqual(isIgnoredPath('src/distribution/x.ts'), false);
  });
});

suite('paths/isTestPath', () => {
  const tests = [
    'src/foo.test.ts',
    'src/foo.spec.js',
    'tests/test_math.py',
    'test/helper.rb',
    '__tests__/a.tsx',
    'e2e/login.ts',
    'pkg/handler_test.go'
  ];
  for (const p of tests) {
    test(`detects ${p}`, () => assert.strictEqual(isTestPath(p), true));
  }

  test('does not flag production code', () => {
    assert.strictEqual(isTestPath('src/latest.ts'), false);
    assert.strictEqual(isTestPath('src/protest.py'), false);
  });
});

suite('paths/isGeneratedPath', () => {
  const generated = ['app.min.js', 'main.bundle.js', 'index.js.map', 'package-lock.json', 'Cargo.lock', 'types.d.ts'];
  for (const p of generated) {
    test(`detects ${p}`, () => assert.strictEqual(isGeneratedPath(p), true));
  }

  test('does not flag ordinary source', () => {
    assert.strictEqual(isGeneratedPath('src/app.ts'), false);
  });
});

suite('paths/resolveWithinRoot', () => {
  const root = path.resolve('C:/repo');

  test('resolves a simple relative directory', () => {
    assert.strictEqual(resolveWithinRoot(root, '.ai-repair'), path.resolve(root, '.ai-repair'));
  });

  test('resolves a nested relative directory', () => {
    assert.strictEqual(resolveWithinRoot(root, 'a/b/c'), path.resolve(root, 'a/b/c'));
  });

  test('rejects parent traversal', () => {
    assert.strictEqual(resolveWithinRoot(root, '../escape'), undefined);
  });

  test('rejects deep parent traversal', () => {
    assert.strictEqual(resolveWithinRoot(root, 'a/../../escape'), undefined);
  });

  test('rejects an absolute posix path', () => {
    assert.strictEqual(resolveWithinRoot(root, '/etc/passwd'), undefined);
  });

  test('rejects an absolute Windows path', () => {
    assert.strictEqual(resolveWithinRoot(root, 'C:\\Windows\\System32'), undefined);
  });

  test('rejects a UNC path', () => {
    assert.strictEqual(resolveWithinRoot(root, '\\\\server\\share'), undefined);
  });

  test('rejects an empty value', () => {
    assert.strictEqual(resolveWithinRoot(root, '   '), undefined);
  });

  test('rejects when there is no root', () => {
    assert.strictEqual(resolveWithinRoot('', '.ai-repair'), undefined);
  });
});

suite('paths/isWithin', () => {
  test('accepts a nested path', () => {
    assert.strictEqual(isWithin('C:/repo', 'C:/repo/src/a.ts'), true);
  });

  test('accepts the root itself', () => {
    assert.strictEqual(isWithin('C:/repo', 'C:/repo'), true);
  });

  test('rejects a sibling', () => {
    assert.strictEqual(isWithin('C:/repo', 'C:/other/a.ts'), false);
  });

  test('rejects a prefix-sharing sibling', () => {
    assert.strictEqual(isWithin('C:/repo', 'C:/repo-backup/a.ts'), false);
  });
});

suite('paths/displayPath', () => {
  test('relativizes inside the workspace', () => {
    assert.strictEqual(displayPath('C:/repo', 'C:/repo/src/a.ts'), 'src/a.ts');
  });

  test('falls back to the basename outside the workspace', () => {
    assert.strictEqual(displayPath('C:/repo', 'C:/Users/someone/secret/a.ts'), 'a.ts');
  });

  test('handles a missing root', () => {
    assert.strictEqual(displayPath(undefined, 'C:\\a\\b.ts'), 'C:/a/b.ts');
  });
});

suite('paths/extensions', () => {
  test('extracts an extension', () => {
    assert.strictEqual(extensionOf('src/a.TS'), 'ts');
  });

  test('returns empty for an extensionless path', () => {
    assert.strictEqual(extensionOf('src/Makefile'), '');
  });

  test('recognizes source extensions', () => {
    assert.strictEqual(hasSourceExtension('a.ts'), true);
    assert.strictEqual(hasSourceExtension('a.py'), true);
    assert.strictEqual(hasSourceExtension('a.zzz'), false);
  });

  test('recognizes extensionless well-known files', () => {
    assert.strictEqual(hasSourceExtension('Dockerfile'), true);
    assert.strictEqual(hasSourceExtension('build/Makefile'), true);
  });
});
