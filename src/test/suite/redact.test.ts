import * as assert from 'assert';
import { PLACEHOLDER, anonymizeHomePaths, redact, redactWithReport, ruleNames } from '../../privacy/redact';

/** Asserts the secret is gone and the placeholder took its place. */
function assertRedacted(input: string, secret: string): string {
  const out = redact(input);
  assert.ok(!out.includes(secret), `secret leaked: ${out}`);
  assert.ok(out.includes(PLACEHOLDER), `no placeholder in: ${out}`);
  return out;
}

suite('redact/vendor tokens', () => {
  const secrets: Array<[string, string]> = [
    ['github classic', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['github oauth', 'gho_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['github fine-grained', 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789'],
    ['aws access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['aws session key', 'ASIAIOSFODNN7EXAMPLE'],
    ['anthropic', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'],
    ['openai', 'sk-abcdefghijklmnopqrstuvwxyz0123456789'],
    ['openai project', 'sk-proj-abcdefghijklmnopqrstuvwxyz0123'],
    ['slack bot', 'xoxb-123456789012-abcdefghijklmnop'],
    ['stripe live', 'sk_live_abcdefghijklmnopqrstuvwx'],
    ['google api', 'AIzaSyA1234567890abcdefghijklmnopqrstuvw'],
    ['npm token', 'npm_abcdefghijklmnopqrstuvwxyz0123456789ab']
  ];

  for (const [label, secret] of secrets) {
    test(`redacts a ${label} token`, () => {
      assertRedacted(`the token is ${secret} ok`, secret);
    });
  }

  test('redacts a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    assertRedacted(`Authorization failed for ${jwt}`, jwt);
  });

  test('redacts a private key block', () => {
    const key = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAxyz1234567890abcdefghijklmnop',
      'qrstuvwxyz0987654321ABCDEFGHIJKLMNOPQRSTUVWX',
      '-----END RSA PRIVATE KEY-----'
    ].join('\n');
    const out = redact(`loaded key:\n${key}\ndone`);
    assert.ok(!out.includes('MIIEowIBAAKCAQEA'));
    assert.ok(out.includes('private key'));
    assert.ok(out.includes('done'), 'surrounding text survives');
  });

  test('redacts an ssh public key', () => {
    assertRedacted('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC1234567890 user@host', 'AAAAB3NzaC1yc2E');
  });
});

suite('redact/labelled secrets', () => {
  test('redacts an api key assignment while keeping the label', () => {
    const out = assertRedacted('api_key=supersecretvalue123', 'supersecretvalue123');
    assert.ok(out.startsWith('api_key='), `label lost: ${out}`);
  });

  test('handles colon separators', () => {
    assertRedacted('apiKey: supersecretvalue123', 'supersecretvalue123');
  });

  test('handles quoted values', () => {
    assertRedacted('password = "hunter2hunter2"', 'hunter2hunter2');
  });

  test('redacts single-quoted values', () => {
    assertRedacted("client_secret: 'abcdef123456789'", 'abcdef123456789');
  });

  test('redacts an env-style secret', () => {
    assertRedacted('DATABASE_PASSWORD=p4ssw0rd!x', 'p4ssw0rd!x');
  });

  test('redacts an uppercase token variable', () => {
    assertRedacted('GITHUB_TOKEN=abcdef0123456789', 'abcdef0123456789');
  });

  test('redacts a bearer header', () => {
    const out = assertRedacted('Authorization: Bearer abcdef.123456', 'abcdef.123456');
    assert.ok(out.toLowerCase().includes('bearer'), 'scheme is kept for context');
  });

  test('redacts basic auth', () => {
    assertRedacted('authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz');
  });

  test('redacts credentials embedded in a URL', () => {
    const out = assertRedacted('postgres://admin:hunter2@db.internal:5432/app', 'hunter2');
    assert.ok(out.includes('db.internal'), 'host survives so the error stays diagnosable');
    assert.ok(out.includes('admin'), 'username survives');
  });

  test('redacts an Azure account key', () => {
    assertRedacted('AccountKey=abcdefghijklmnopqrstuvwxyz0123456789==', 'abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

suite('redact/false positives', () => {
  test('leaves ordinary error text alone', () => {
    const input = "TypeError: Cannot read properties of undefined (reading 'length')";
    assert.strictEqual(redact(input), input);
  });

  test('leaves a stack trace alone', () => {
    const input = '    at Object.<anonymous> (/app/src/index.js:6:15)';
    assert.strictEqual(redact(input, { anonymizeHome: false }), input);
  });

  test('leaves a normal URL alone', () => {
    const input = 'fetch failed for https://api.example.com/v1/users';
    assert.strictEqual(redact(input), input);
  });

  test('does not redact emails by default', () => {
    const input = 'commit authored by dev@example.com';
    assert.strictEqual(redact(input), input);
  });

  test('redacts emails when asked', () => {
    const out = redact('contact dev@example.com', { redactEmails: true });
    assert.ok(!out.includes('dev@example.com'));
    assert.ok(out.includes(PLACEHOLDER));
  });

  test('leaves a plain assignment alone', () => {
    const input = 'count = 42';
    assert.strictEqual(redact(input), input);
  });
});

suite('redact/home paths', () => {
  test('anonymizes a Windows home directory', () => {
    const out = redact('C:\\Users\\alice\\projects\\app\\src\\a.ts:12');
    assert.ok(!out.includes('alice'));
    assert.ok(out.includes('<home>'));
    assert.ok(out.includes('projects'), 'the rest of the path survives');
  });

  test('anonymizes a macOS home directory', () => {
    const out = redact('/Users/bob/code/app/main.py');
    assert.ok(!out.includes('bob'));
    assert.ok(out.includes('/code/app/main.py'));
  });

  test('anonymizes a Linux home directory', () => {
    const out = redact('/home/carol/app/main.py');
    assert.ok(!out.includes('carol'));
  });

  test('can be disabled', () => {
    const input = '/home/carol/app/main.py';
    assert.strictEqual(redact(input, { anonymizeHome: false }), input);
  });

  test('anonymizeHomePaths works standalone', () => {
    assert.strictEqual(anonymizeHomePaths('/home/dan/x'), '<home>/x');
  });
});

suite('redact/reporting', () => {
  test('counts what it removed', () => {
    const result = redactWithReport('token=abc123456 and AKIAIOSFODNN7EXAMPLE');
    assert.ok(result.total >= 2, `expected at least two redactions, got ${result.total}`);
    assert.ok(Object.keys(result.counts).length >= 2);
  });

  test('reports zero for clean text', () => {
    const result = redactWithReport('nothing to see here');
    assert.strictEqual(result.total, 0);
    assert.deepStrictEqual(result.counts, {});
  });

  test('handles empty input', () => {
    const result = redactWithReport('');
    assert.strictEqual(result.text, '');
    assert.strictEqual(result.total, 0);
  });

  test('names every rule', () => {
    assert.ok(ruleNames().length > 15);
    assert.ok(ruleNames().includes('github-token'));
  });
});

suite('redact/robustness', () => {
  test('is idempotent', () => {
    const once = redact('api_key=secret123456 and ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    assert.strictEqual(redact(once), once);
  });

  test('survives repeated calls without regex state leaking', () => {
    const input = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 5; i++) {
      assert.ok(!redact(input).includes('abcdefghij'), `leaked on iteration ${i}`);
    }
  });

  test('redacts every occurrence on a line', () => {
    const out = redact('a=AKIAIOSFODNN7EXAMPLE b=AKIAIOSFODNN7EXAMPL2');
    assert.ok(!out.includes('AKIA'));
  });

  test('stays fast on large input', () => {
    const big = ('some ordinary log line with no secrets at all\n').repeat(20000);
    const start = Date.now();
    redact(big);
    assert.ok(Date.now() - start < 5000, 'redaction should stay linear');
  });

  test('stays fast on adversarial input', () => {
    const adversarial = `api_key=${'a'.repeat(100000)}`;
    const start = Date.now();
    redact(adversarial);
    assert.ok(Date.now() - start < 5000, 'bounded quantifiers prevent backtracking blowups');
  });

  test('accepts custom patterns', () => {
    const out = redact('INTERNAL-9999 leaked', { extraPatterns: [/INTERNAL-\d{4}/g] });
    assert.ok(!out.includes('INTERNAL-9999'));
  });
});
