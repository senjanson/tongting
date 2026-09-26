/**
 * 服务在错误正文里回显 Key 时的脱敏：通用规则覆盖不带前缀的长 Key，已登记的凭证按原文替换。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { redactSecrets } from '@src/domain/errors';
import { forgetKnownSecrets, rememberSecret, scrubKnownSecrets } from '@src/domain/known-secrets';
import { redact, redactString } from '@src/diagnostics/redact';
import { errorFromHttpStatus, sanitizeDetail } from '@src/providers/text/http-errors';

afterEach(() => forgetKnownSecrets());

const HEX_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('错误文本脱敏：不带前缀的 Key', () => {
  it('32 位十六进制 Key 被服务回显时，错误详情里不出现原文', () => {
    const body = JSON.stringify({
      error: { message: `Invalid API key: ${HEX_KEY}`, type: 'invalid_request_error' },
    });
    const info = errorFromHttpStatus(401, new Headers(), body);
    expect(info.code).toBe('auth-invalid');
    expect(info.detail).not.toContain(HEX_KEY);
    expect(info.detail).toContain('Invalid API key');
  });

  it('不误伤常见的短标识、模型名与纯字母或纯数字长串', () => {
    const text =
      'model gpt-4o-mini-transcribe-2025-03-20 video dQw4w9WgXcQ req_0123456789abcdef0123456789 ' +
      'consecutiveFailedCallsWithinWindow 123456789012345678901234567890';
    expect(redactSecrets(text)).toBe(text);
  });

  it('流式错误等调用 sanitizeDetail 的路径同样生效', () => {
    expect(sanitizeDetail(`invalid_api_key Incorrect key ${HEX_KEY} provided`)).toBe(
      'invalid_api_key Incorrect key [REDACTED_KEY] provided',
    );
  });
});

describe('已登记凭证按原文脱敏', () => {
  const ODD_KEY = 'my.custom-key_value!42';

  it('任意格式的已登记 Key 在错误文本与诊断日志中都被替换', () => {
    rememberSecret(` ${ODD_KEY} `);
    expect(redactSecrets(`upstream said: key ${ODD_KEY} rejected`)).toBe(
      'upstream said: key [REDACTED_KEY] rejected',
    );
    expect(redactString(`echo ${ODD_KEY}`)).toBe('echo [redacted]');
    expect(JSON.stringify(redact({ error: { detail: `bad ${ODD_KEY}` } }))).not.toContain(ODD_KEY);
  });

  it('超长字符串先替换再截断，截断后不残留 Key 片段', () => {
    rememberSecret(ODD_KEY);
    const out = redactString(`${'x '.repeat(145)}${ODD_KEY}`);
    expect(out).not.toContain('my.custom');
  });

  it('太短的值不登记；最多保留 8 个，换 Key 后旧值仍会脱敏', () => {
    rememberSecret('short');
    rememberSecret(undefined);
    expect(scrubKnownSecrets('short', '#')).toBe('short');
    for (let i = 0; i < 9; i++) rememberSecret(`secret-value-${i}`);
    expect(scrubKnownSecrets('secret-value-0', '#')).toBe('secret-value-0');
    expect(scrubKnownSecrets('secret-value-1 secret-value-8', '#')).toBe('# #');
  });

  it('诊断日志不因通用规则误伤会话 ID', () => {
    expect(redactString('session s577617c04a6dea6dab9f9924')).toBe(
      'session s577617c04a6dea6dab9f9924',
    );
  });
});
