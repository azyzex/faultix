import * as assert from 'assert';
import {
  describeKind,
  inferKindFromCommand,
  inferKindFromTaskName,
  inferToolHint,
  refineKindFromOutput
} from '../../analyze/classify';

suite('classify/inferToolHint', () => {
  const cases: Array<[string, string]> = [
    ['npx tsc --noEmit', 'tsc'],
    ['eslint src --max-warnings 0', 'eslint'],
    ['npx vitest run', 'vitest'],
    ['npx jest --coverage', 'jest'],
    ['pytest -q tests/', 'pytest'],
    ['python -m pytest', 'pytest'],
    ['cargo build --release', 'cargo'],
    ['go test ./...', 'go'],
    ['mvn clean verify', 'maven'],
    ['./gradlew assemble', 'gradle'],
    ['dotnet build', 'dotnet'],
    ['gcc -o main main.c', 'gcc'],
    ['make -C build', 'make'],
    ['docker build -t app .', 'docker'],
    ['terraform apply', 'terraform'],
    ['composer install', 'composer'],
    ['bundle exec rspec', 'rspec'],
    ['node server.js', 'node'],
    ['deno run main.ts', 'deno'],
    ['pnpm install', 'pnpm'],
    ['yarn build', 'yarn'],
    ['git push origin main', 'git']
  ];

  for (const [command, expected] of cases) {
    test(`${command} -> ${expected}`, () => {
      assert.strictEqual(inferToolHint(command), expected);
    });
  }

  test('resolves the runner rather than the package manager', () => {
    assert.strictEqual(inferToolHint('npm run test -- vitest'), 'vitest');
  });

  test('falls back to the package manager when the script hides the tool', () => {
    // `npm run lint` says nothing about which linter runs; npm is the honest answer.
    assert.strictEqual(inferToolHint('npm run lint -- --fix'), 'npm');
  });

  test('sees through an absolute Windows interpreter path', () => {
    assert.strictEqual(inferToolHint('C:\\tools\\Python311\\python.exe script.py'), 'python');
  });

  test('returns undefined for an unrecognized command', () => {
    assert.strictEqual(inferToolHint('frobnicate --all'), undefined);
  });

  test('handles an empty command', () => {
    assert.strictEqual(inferToolHint(''), undefined);
  });
});

suite('classify/inferKindFromCommand', () => {
  const cases: Array<[string, string]> = [
    ['npm install', 'packageinstall'],
    ['npm ci', 'packageinstall'],
    ['yarn add react', 'packageinstall'],
    ['pip install -r requirements.txt', 'packageinstall'],
    ['bundle install', 'packageinstall'],
    ['npm test', 'test'],
    ['npx vitest run', 'test'],
    ['pytest -q', 'test'],
    ['go test ./...', 'test'],
    ['cargo test', 'test'],
    ['dotnet test', 'test'],
    ['npm run lint', 'lint'],
    ['ruff check .', 'lint'],
    ['npx tsc --noEmit', 'typecheck'],
    ['mypy src', 'typecheck'],
    ['npm run build', 'build'],
    ['cargo build', 'build'],
    ['make', 'build'],
    ['docker build .', 'build'],
    ['node index.js', 'runtime'],
    ['python app.py', 'runtime'],
    ['./scripts/deploy.sh', 'runtime']
  ];

  for (const [command, expected] of cases) {
    test(`${command} -> ${expected}`, () => {
      assert.strictEqual(inferKindFromCommand(command), expected);
    });
  }

  test('classifies a bare batch script as runtime', () => {
    assert.strictEqual(inferKindFromCommand('cmd /c "scripts\\bad.bat"'), 'runtime');
  });

  test('returns unknown when nothing matches', () => {
    assert.strictEqual(inferKindFromCommand('frobnicate'), 'unknown');
  });

  test('prefers install over test when both words appear', () => {
    assert.strictEqual(inferKindFromCommand('npm install --include=test'), 'packageinstall');
  });
});

suite('classify/inferKindFromTaskName', () => {
  test('reads a prose task name', () => {
    assert.strictEqual(inferKindFromTaskName('Node: syntax error (broken_syntax.js)'), 'runtime');
  });

  test('detects a test task', () => {
    assert.strictEqual(inferKindFromTaskName('Run unit tests'), 'test');
  });

  test('detects a build task', () => {
    assert.strictEqual(inferKindFromTaskName('Compile TypeScript'), 'build');
  });

  test('detects a lint task', () => {
    assert.strictEqual(inferKindFromTaskName('eslint everything'), 'lint');
  });

  test('falls back to command classification', () => {
    assert.strictEqual(inferKindFromTaskName('cargo build --release'), 'build');
  });
});

suite('classify/refineKindFromOutput', () => {
  test('promotes unknown to runtime for a python traceback', () => {
    const output = 'Traceback (most recent call last):\n  File "x.py", line 1\nValueError: bad';
    assert.strictEqual(refineKindFromOutput('unknown', output), 'runtime');
  });

  test('promotes unknown to typecheck for tsc output', () => {
    assert.strictEqual(refineKindFromOutput('unknown', 'a.ts(1,1): error TS2345: nope'), 'typecheck');
  });

  test('promotes unknown to packageinstall for npm resolution errors', () => {
    assert.strictEqual(refineKindFromOutput('unknown', 'npm ERR! ERESOLVE could not resolve'), 'packageinstall');
  });

  test('leaves an already-known kind alone', () => {
    assert.strictEqual(refineKindFromOutput('test', 'Traceback (most recent call last):'), 'test');
  });

  test('leaves unknown alone when the output says nothing', () => {
    assert.strictEqual(refineKindFromOutput('unknown', 'all good'), 'unknown');
  });

  test('handles empty output', () => {
    assert.strictEqual(refineKindFromOutput('unknown', ''), 'unknown');
  });
});

suite('classify/describeKind', () => {
  test('gives every kind a human label', () => {
    const kinds = ['build', 'test', 'runtime', 'lint', 'typecheck', 'packageinstall', 'unknown'] as const;
    for (const kind of kinds) {
      const label = describeKind(kind);
      assert.ok(label.length > 3, `${kind} should have a readable label`);
    }
  });
});
