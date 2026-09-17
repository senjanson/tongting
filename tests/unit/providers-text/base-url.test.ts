import { describe, expect, it } from 'vitest';
import { apiEndpoint, normalizeBaseUrl } from '@src/providers/text/base-url';

function ok(input: string) {
  const r = normalizeBaseUrl(input);
  if (!r.ok) throw new Error(`expected ok for ${input}: ${r.error.code}`);
  return r;
}

function errCode(input: string): string {
  const r = normalizeBaseUrl(input);
  if (r.ok) throw new Error(`expected error for ${input}`);
  expect(r.error.category).toBe('config');
  expect(r.error.message).toMatch(/[一-鿿]/);
  return r.error.code;
}

describe('normalizeBaseUrl', () => {
  it.each([
    'https://x.com',
    'https://x.com/',
    'https://x.com/v1',
    'https://x.com/v1/',
    'https://X.com/V1//',
    '  https://x.com/v1  ',
    'https://x.com/v1/chat/completions',
    'https://x.com/v1/responses',
    'https://x.com/v1/models/',
  ])('normalizes %s to the API root without /v1', (input) => {
    const r = ok(input);
    expect(r.baseUrl).toBe('https://x.com');
    expect(r.origin).toBe('https://x.com');
    expect(r.originPattern).toBe('https://x.com/*');
    expect(apiEndpoint(r.baseUrl, '/v1/responses')).toBe('https://x.com/v1/responses');
  });

  it('keeps reverse-proxy sub paths and never duplicates /v1', () => {
    for (const input of [
      'https://gw.example.com/sub2api',
      'https://gw.example.com/sub2api/',
      'https://gw.example.com/sub2api/v1/',
    ]) {
      const r = ok(input);
      expect(r.baseUrl).toBe('https://gw.example.com/sub2api');
      expect(apiEndpoint(r.baseUrl, '/v1/chat/completions')).toBe(
        'https://gw.example.com/sub2api/v1/chat/completions',
      );
      expect(r.originPattern).toBe('https://gw.example.com/*');
    }
  });

  it('keeps non-default ports in origin and origin pattern', () => {
    const r = ok('https://api.example.com:8443/v1');
    expect(r.origin).toBe('https://api.example.com:8443');
    expect(r.originPattern).toBe('https://api.example.com:8443/*');
  });

  it('allows http only for 127.0.0.1 (not localhost, not ::1, not LAN)', () => {
    expect(ok('http://127.0.0.1:8080/v1').baseUrl).toBe('http://127.0.0.1:8080');
    expect(ok('http://127.0.0.1:8080/v1').originPattern).toBe('http://127.0.0.1:8080/*');
    expect(errCode('http://localhost:3000')).toBe('base-url-insecure');
    expect(errCode('http://[::1]:3000')).toBe('base-url-insecure');
    expect(errCode('http://api.example.com')).toBe('base-url-insecure');
    expect(errCode('http://192.168.1.2:8080')).toBe('base-url-insecure');
    // https 的 localhost / IP 地址是具体主机，允许
    expect(ok('https://localhost:8443').originPattern).toBe('https://localhost:8443/*');
    expect(ok('https://[2001:db8::1]/v1').originPattern).toBe('https://[2001:db8::1]/*');
  });

  it.each([
    'https://*/',
    'https://*',
    'https://*.example.com/v1',
    'https://api.*.example.com',
    'https://%2A.example.com',
    'http://*:8080',
    'https://exa*mple.com',
    'https://example.com./v1',
    'https://-bad-.example.com',
    'https://a..b.com',
  ])('rejects %s so that originPattern can never cover more than one origin', (input) => {
    expect(errCode(input)).toMatch(/^base-url-(host-invalid|invalid)$/);
  });

  it('accepts internationalized domains as their single punycode origin', () => {
    const r = ok('https://例子.测试/v1');
    expect(r.origin).toMatch(/^https:\/\/xn--[a-z0-9-]+\.xn--[a-z0-9-]+$/);
    expect(r.originPattern).toBe(`${r.origin}/*`);
  });

  it('rejects credentials, query, fragment, bad schemes and garbage', () => {
    expect(errCode('')).toBe('base-url-empty');
    expect(errCode('api.example.com')).toBe('base-url-no-scheme');
    expect(errCode('ftp://x.com')).toBe('base-url-scheme');
    expect(errCode('https://user:pass@x.com')).toBe('base-url-credentials');
    expect(errCode('https://user@x.com')).toBe('base-url-credentials');
    expect(errCode('https://@x.com')).toBe('base-url-credentials');
    expect(errCode('https://*:pw@x.com')).toBe('base-url-credentials');
    expect(errCode('https://x.com/v1?key=abc')).toBe('base-url-query');
    expect(errCode('https://x.com/v1?')).toBe('base-url-query');
    expect(errCode('https://*.x.com/?a=1')).toBe('base-url-query');
    expect(errCode('https://x.com/#frag')).toBe('base-url-fragment');
    expect(errCode('https://x .com')).toBe('base-url-invalid');
    expect(errCode('https://')).toBe('base-url-invalid');
  });

  it('never echoes the raw input (which may contain secrets) in error messages', () => {
    const r = normalizeBaseUrl('https://x.com/v1?key=sk-SHOULDNOTLEAK123456');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).not.toContain('SHOULDNOTLEAK');
  });
});
