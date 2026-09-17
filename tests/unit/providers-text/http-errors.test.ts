import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '@src/domain/errors';
import {
  errorFromHttpStatus,
  networkError,
  parseRetryAfter,
  sanitizeDetail,
} from '@src/providers/text/http-errors';
import { withRequestSignal } from '@src/providers/text/http';
import { errorFromPayload } from '@src/providers/text/protocol';
import { isAutoRetryable, isBlockingError } from '@src/translation/retry';

const FIXTURES = resolve(__dirname, '../../fixtures/sub2api');
const h = (init: Record<string, string> = {}) => new Headers(init);

describe('parseRetryAfter', () => {
  it('parses seconds, HTTP dates and retry-after-ms', () => {
    expect(parseRetryAfter(h({ 'retry-after': '3' }))).toBe(3000);
    expect(parseRetryAfter(h({ 'retry-after': '1.5' }))).toBe(1500);
    const now = Date.parse('2026-09-16T00:00:00Z');
    expect(parseRetryAfter(h({ 'retry-after': 'Wed, 16 Sep 2026 00:00:10 GMT' }), now)).toBe(
      10_000,
    );
    expect(parseRetryAfter(h({ 'retry-after': 'Wed, 16 Sep 2026 00:00:00 GMT' }), now + 5000)).toBe(
      0,
    );
    expect(parseRetryAfter(h({ 'retry-after-ms': '250', 'retry-after': '9' }))).toBe(250);
    expect(parseRetryAfter(h({ 'retry-after': 'soon' }))).toBeUndefined();
    expect(parseRetryAfter(h())).toBeUndefined();
  });
});

describe('errorFromHttpStatus', () => {
  it('maps status codes to categories and retryability', () => {
    const map = (status: number, body = '', headers = h()) =>
      errorFromHttpStatus(status, headers, body);
    expect(map(401)).toMatchObject({ category: 'auth', retryable: false, code: 'auth-invalid' });
    expect(map(402)).toMatchObject({ category: 'quota', retryable: false });
    expect(map(403, '{"error":{"message":"Group has no access to model x"}}')).toMatchObject({
      category: 'permission',
      code: 'model-forbidden',
      retryable: false,
    });
    expect(map(403, '{"error":{"message":"余额不足"}}')).toMatchObject({ category: 'quota' });
    expect(
      map(404, '{"error":{"message":"The model `x` does not exist","code":"model_not_found"}}'),
    ).toMatchObject({
      category: 'config',
      code: 'model-not-found',
    });
    expect(map(404, 'Not Found')).toMatchObject({
      category: 'unsupported',
      code: 'endpoint-not-found',
    });
    expect(map(405)).toMatchObject({ category: 'unsupported', code: 'endpoint-unsupported' });
    expect(map(429, '', h({ 'retry-after': '2' }))).toMatchObject({
      category: 'rate-limit',
      retryable: true,
      retryAfterMs: 2000,
    });
    expect(map(500)).toMatchObject({ category: 'server', retryable: true });
    expect(map(503, '<html><body>Bad gateway</body></html>')).toMatchObject({
      category: 'server',
      httpStatus: 503,
    });
    expect(map(302)).toMatchObject({
      category: 'network',
      code: 'redirect-blocked',
      retryable: false,
    });
    expect(
      map(
        400,
        '{"error":{"message":"Unsupported parameter: response_format","param":"response_format"}}',
      ),
    ).toMatchObject({
      category: 'unsupported',
      code: 'unsupported-parameter',
    });
  });

  it('treats 429 insufficient_quota as quota (not retryable)', () => {
    const body = readFileSync(resolve(FIXTURES, 'error-insufficient-quota-429.json'), 'utf8');
    expect(errorFromHttpStatus(429, h({ 'retry-after': '1' }), body)).toMatchObject({
      category: 'quota',
      retryable: false,
    });
  });

  it('redacts keys, tokens and URLs from service error details', () => {
    const body = readFileSync(resolve(FIXTURES, 'error-openai-401.json'), 'utf8');
    const info = errorFromHttpStatus(401, h(), body);
    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain('sk-FAKEFIXTUREKEY000000');
    expect(serialized).not.toContain('FAKETOKEN123');
    expect(serialized).not.toContain('/account/api-keys');
    expect(info.detail).toContain('invalid_api_key');
    expect(info.message.length).toBeLessThanOrEqual(500);
  });

  it('sanitizeDetail truncates and strips bearer tokens', () => {
    const out = sanitizeDetail(`Authorization: Bearer abc.def.ghi ${'x'.repeat(500)}`, 50)!;
    expect(out).not.toContain('abc.def.ghi');
    expect(out.length).toBeLessThanOrEqual(50);
  });
});

describe('errorFromHttpStatus: only explicit signals block the whole session (review #1)', () => {
  const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), 'utf8');

  it.each([
    ['error-400-invalid-prompt.json', 'content-rejected'],
    ['error-400-context-length.json', 'context-too-long'],
    ['error-400-generic.json', 'bad-request'],
  ])(
    '%s is a per-batch format failure (%s), not a blocking unsupported-parameter',
    (name, code) => {
      const info = errorFromHttpStatus(400, h(), fixture(name));
      expect(info).toMatchObject({ code, category: 'format', httpStatus: 400 });
      expect(isBlockingError(info)).toBe(false);
      expect(isAutoRetryable(info)).toBe(false);
    },
  );

  it.each(['error-400-unsupported-reasoning.json', 'error-400-invalid-schema.json'])(
    '%s names an optional parameter we send → unsupported-parameter (degradable / blocking)',
    (name) => {
      const info = errorFromHttpStatus(400, h(), fixture(name));
      expect(info).toMatchObject({ code: 'unsupported-parameter', category: 'unsupported' });
      expect(isBlockingError(info)).toBe(true);
    },
  );

  it('does not treat a parameter name that only appears inside a URL as a parameter rejection', () => {
    const info = errorFromHttpStatus(
      400,
      h(),
      JSON.stringify({
        error: {
          message: 'Bad thing. See https://docs.example.com/guides/reasoning#text.format',
          type: 'invalid_request_error',
        },
      }),
    );
    expect(info.code).toBe('bad-request');
  });

  it('upstream pass-through 400 without structure stays a per-batch failure', () => {
    const info = errorFromHttpStatus(400, h(), 'upstream error: bad gateway body invalid');
    expect(info).toMatchObject({ code: 'bad-request', category: 'format' });
    expect(isBlockingError(info)).toBe(false);
  });

  it('429 is rate-limit unless code/type is an explicit quota code, even if the message mentions billing', () => {
    const limited = errorFromHttpStatus(
      429,
      h({ 'retry-after': '20' }),
      fixture('error-429-rate-limit-billing.json'),
    );
    expect(limited).toMatchObject({
      category: 'rate-limit',
      retryable: true,
      retryAfterMs: 20_000,
    });
    expect(isBlockingError(limited)).toBe(false);
    const credit = errorFromHttpStatus(
      429,
      h(),
      JSON.stringify({ error: { message: 'credit balance billing', type: 'tokens' } }),
    );
    expect(credit.category).toBe('rate-limit');
    const quota = errorFromHttpStatus(429, h(), fixture('error-insufficient-quota-429.json'));
    expect(quota).toMatchObject({ category: 'quota', retryable: false });
  });

  it('403 with an explicit balance code or Chinese balance message is quota; other 403s are permission', () => {
    expect(errorFromHttpStatus(403, h(), fixture('error-403-balance-zh.json')).category).toBe(
      'quota',
    );
    expect(
      errorFromHttpStatus(403, h(), JSON.stringify({ error: { message: 'billing page moved' } }))
        .category,
    ).toBe('permission');
  });

  it('stream/200 error payloads use code/type, not message words', () => {
    expect(
      errorFromPayload({ code: 'rate_limit_exceeded', message: 'add billing' }).info.category,
    ).toBe('rate-limit');
    expect(errorFromPayload({ type: 'insufficient_quota', message: 'x' }).info.category).toBe(
      'quota',
    );
    expect(errorFromPayload({ message: 'rate limit? billing credit balance' }).info.category).toBe(
      'server',
    );
  });
});

describe('withRequestSignal', () => {
  it('maps user abort to cancelled even if the operation ignores the signal', async () => {
    const controller = new AbortController();
    const never = new Promise<never>(() => undefined);
    const p = withRequestSignal(controller.signal, 10_000, () => never);
    controller.abort();
    await expect(p).rejects.toMatchObject({ info: { category: 'cancelled' } });
  });

  it('maps timeout to a retryable timeout error and aborts the inner signal', async () => {
    let inner: AbortSignal | undefined;
    const p = withRequestSignal(new AbortController().signal, 20, (signal) => {
      inner = signal;
      return new Promise<never>(() => undefined);
    });
    await expect(p).rejects.toMatchObject({ info: { category: 'timeout', retryable: true } });
    expect(inner?.aborted).toBe(true);
  });

  it('maps TypeError to network error and passes AppError through', async () => {
    const signal = new AbortController().signal;
    await expect(
      withRequestSignal(signal, 1000, async () => Promise.reject(new TypeError('fetch failed'))),
    ).rejects.toMatchObject({
      info: { category: 'network', retryable: true },
    });
    const appError = new AppError({ code: 'x', category: 'auth', retryable: false, message: 'm' });
    await expect(
      withRequestSignal(signal, 1000, async () => Promise.reject(appError)),
    ).rejects.toBe(appError);
  });

  it('recognizes undici redirect errors as redirect-blocked', () => {
    const err = new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    expect(networkError(err).info).toMatchObject({ code: 'redirect-blocked', retryable: false });
  });
});
