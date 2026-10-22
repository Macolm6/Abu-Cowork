import { describe, it, expect } from 'vitest';
import { redactText, redactDeep } from './shareRedactor';

describe('shareRedactor', () => {
  describe('redactText', () => {
    it('redacts Anthropic API keys', () => {
      const input = 'key=sk-ant-abc123def456ghi789jkl012mno345pqr678 end';
      const r = redactText(input);
      expect(r.text).toContain('[REDACTED:anthropic-key]');
      expect(r.text).not.toContain('sk-ant-abc');
      expect(r.count).toBe(1);
    });

    it('redacts OpenAI keys without matching Anthropic', () => {
      const input = 'openai=sk-abcdef123456789012345678 anthropic=sk-ant-xyz789abcdef1234567890';
      const r = redactText(input);
      expect(r.text).toContain('[REDACTED:openai-key]');
      expect(r.text).toContain('[REDACTED:anthropic-key]');
      // Neither original key should survive.
      expect(r.text).not.toContain('sk-abcdef');
      expect(r.text).not.toContain('sk-ant-xyz');
    });

    it('redacts GitHub tokens (all prefixes)', () => {
      const input = 'ghp_1234567890abcdef1234567890abcdef1234 ghs_abcdef1234567890abcdef1234567890abcd';
      const r = redactText(input);
      expect(r.text.match(/\[REDACTED:github-token\]/g)?.length).toBe(2);
    });

    it('redacts JWT tokens', () => {
      const input = 'token=eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT';
      const r = redactText(input);
      expect(r.text).toContain('[REDACTED:jwt]');
    });

    it('redacts Bearer tokens but keeps the header label', () => {
      const r = redactText('Authorization: Bearer abc123def456ghi789jkl012mno345pqr');
      expect(r.text).toMatch(/Authorization: Bearer \[REDACTED:bearer\]/);
    });

    it('redacts private key blocks', () => {
      const input = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
      const r = redactText(input);
      expect(r.text).toBe('[REDACTED:private-key-block]');
      expect(r.count).toBe(1);
    });

    it('redacts each complete private key block among headers that have no end line', () => {
      const header = '-----BEGIN PRIVATE KEY-----\n';
      const block = '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----';
      const r = redactText(`${header}x\n${header}a\n${block}\n${header.repeat(3)}tail`);
      expect(r.text).toBe(`[REDACTED:private-key-block]\n${header.repeat(3)}tail`);
      expect(r.count).toBe(1);
    });

    it('redacts a private key block whose header shares its closing dashes with an end line', () => {
      const r = redactText('-----BEGIN PRIVATE KEY-----END PRIVATE KEY-----END PRIVATE KEY-----');
      expect(r.text).toBe('[REDACTED:private-key-block]');
      expect(r.count).toBe(1);
    });

    it('redacts a JWT that follows other token characters, keeping them', () => {
      const r = redactText('abceyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT end');
      expect(r.text).toBe('abc[REDACTED:jwt] end');
      expect(r.count).toBe(1);
    });

    it('redacts a JWT whose first part holds another "eyJ"', () => {
      const r = redactText('x eyJhbGeyJciOiJI.eyJzdWIiOiIxMjM0.SflKxwRJSMeKK');
      expect(r.text).toBe('x [REDACTED:jwt]');
    });

    it('leaves a long run of "eyJ" with no dot alone', () => {
      const text = 'eyJ'.repeat(50_000);
      expect(redactText(text).text).toBe(text);
    });

    it('leaves private key headers alone when no end line follows', () => {
      const text = `-----END RSA PRIVATE KEY-----\n${'-----BEGIN PRIVATE KEY-----\n'.repeat(5)}`;
      const r = redactText(text);
      expect(r.text).toBe(text);
      expect(r.count).toBe(0);
    });

    it('collapses macOS home paths to ~', () => {
      const r = redactText('read /Users/alice/Documents/file.txt');
      expect(r.text).toBe('read ~/Documents/file.txt');
    });

    it('collapses Linux home paths to ~', () => {
      const r = redactText('log at /home/bob/app.log');
      expect(r.text).toBe('log at ~/app.log');
    });

    it('collapses Windows home paths to ~', () => {
      const r = redactText('see C:\\Users\\Alice\\Desktop\\notes.md for more');
      expect(r.text).toContain('~\\Desktop\\notes.md');
      expect(r.text).not.toContain('C:\\Users\\Alice');
    });

    it('preserves surrounding text and non-matching content', () => {
      const r = redactText('the quick brown fox');
      expect(r.text).toBe('the quick brown fox');
      expect(r.count).toBe(0);
      expect(r.samples).toHaveLength(0);
    });

    it('returns samples with preview capped at 20 chars', () => {
      const r = redactText('sk-ant-abcdefghijklmnopqrstuvwxyz1234567890 hi');
      expect(r.samples[0].kind).toBe('anthropic-key');
      expect(r.samples[0].preview.length).toBeLessThanOrEqual(20);
    });

    it('is a no-op on empty input', () => {
      expect(redactText('').count).toBe(0);
      expect(redactText('').text).toBe('');
    });
  });

  describe('redactDeep', () => {
    it('walks nested objects and arrays', () => {
      const input = {
        msg: 'normal',
        cred: 'sk-ant-abcdefghijklmnopqrstuvwxyz1234567',
        nested: {
          path: '/Users/alice/secret.txt',
          list: ['ok', 'gho_1234567890abcdef1234567890abcdef1234'],
        },
      };
      const { value, count } = redactDeep(input);
      const v = value as typeof input;
      expect(v.msg).toBe('normal');
      expect(v.cred).toContain('[REDACTED:anthropic-key]');
      expect(v.nested.path).toBe('~/secret.txt');
      expect(v.nested.list[1]).toContain('[REDACTED:github-token]');
      expect(count).toBeGreaterThanOrEqual(3);
    });

    it('leaves primitives untouched', () => {
      const { value } = redactDeep({ n: 42, b: true, x: null });
      expect(value).toEqual({ n: 42, b: true, x: null });
    });

    it('returns an object the keep test accepts as it is, and redacts its siblings', () => {
      const kept = { type: 'base64', data: `AIza${'B'.repeat(35)}` };
      const input = { source: kept, note: 'sk-ant-abcdefghijklmnopqrstuvwxyz1234567' };
      const { value, count } = redactDeep(input, (node) => node.type === 'base64');
      const v = value as typeof input;
      expect(v.source).toBe(kept);
      expect(v.note).toBe('[REDACTED:anthropic-key]');
      expect(count).toBe(1);
    });

    it('redacts a credential at the end of a very long string', () => {
      const huge = 'a '.repeat(200_000) + 'sk-ant-abcdefghijklmnopqrstuvwxyz1234567';
      const { value, count } = redactDeep({ content: huge });
      const content = (value as { content: string }).content;
      expect(content).not.toContain('sk-ant-');
      expect(content.endsWith('[REDACTED:anthropic-key]')).toBe(true);
      expect(count).toBe(1);
    });

    it('returns a base64 data URL as it is', () => {
      const url = `data:image/png;base64,iVBOR${'AIza'}${'B'.repeat(35)}${'A'.repeat(2_000)}==`;
      const { value, count } = redactDeep({ image: url });
      expect((value as { image: string }).image).toBe(url);
      expect(count).toBe(0);
    });

    it('redacts text that only begins like a data URL', () => {
      const stream = 'data: {"token":"sk-ant-abcdefghijklmnopqrstuvwxyz1234567"};base64,AAAA';
      const { value, count } = redactDeep({ output: stream });
      expect((value as { output: string }).output).not.toContain('sk-ant-');
      expect(count).toBe(1);
    });
  });
});
