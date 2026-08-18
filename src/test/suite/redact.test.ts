import * as assert from 'assert';
import { redact } from '../../privacy/redact';

suite('redact', () => {
  test('redacts bearer token', () => {
    const input = 'Authorization: Bearer SECRET123';
    const out = redact(input);
    assert.ok(out.includes('<redacted>'));
    assert.ok(!out.includes('SECRET123'));
  });
});
