import { describe, expect, it } from 'vitest';
import { cancelledError, toAppErrorInfo } from '@src/domain/errors';
import { getLocale, setLocale } from '@src/i18n';
import { mapHttpStatus } from '@src/providers/asr/http';
import { normalizeBaseUrl } from '@src/providers/text/base-url';
import { errorFromHttpStatus, timeoutError } from '@src/providers/text/http-errors';
import { runTextConnectionCheck } from '@src/providers/text/connection-check';
import { ProviderSettingsSchema } from '@src/domain/settings';
import { youtubeError } from '@src/youtube/errors';

const CJK = /[一-鿿]/;

describe('worker 与内容脚本文案随 setLocale 切换', () => {
  it('默认是简体中文', () => {
    expect(getLocale()).toBe('zh-CN');
    expect(cancelledError().message).toBe('操作已取消');
    expect(errorFromHttpStatus(401, new Headers(), '').message).toBe(
      'API Key 无效或已失效（401）：请在设置中重新填写 Key 后再试。',
    );
  });

  it("setLocale('en') 后代表性错误为英文", () => {
    setLocale('en');
    expect(cancelledError().message).toBe('Cancelled');
    expect(toAppErrorInfo(new Error('boom')).message).toBe(
      'An internal error occurred. Try again; if it keeps happening, check the extension logs.',
    );
    expect(errorFromHttpStatus(401, new Headers(), '').message).toBe(
      'The API key is invalid or expired (401). Enter the key again in Settings and retry.',
    );
    expect(errorFromHttpStatus(503, new Headers(), '').message).toBe(
      'The service is having trouble (503); it will retry automatically. If it keeps failing, check the sub2api upstream status.',
    );
    expect(timeoutError(15_000).message).toBe(
      'The service did not respond within 15s; it will retry automatically. If this keeps happening, increase the timeout in Settings.',
    );
    const url = normalizeBaseUrl('');
    expect(url.ok).toBe(false);
    expect(!url.ok && url.error.message).toBe(
      'Enter your sub2api service URL (Base URL), e.g. https://api.example.com.',
    );
    expect(youtubeError('ad-playing').message).toBe(
      'An ad is playing. Try again once the video starts.',
    );
    expect(
      mapHttpStatus(429, undefined, undefined, 'sub2api-tts', 'https://api.example.com').message,
    ).toBe('sub2api speech synthesis is busy or rate limited (429); retrying later.');
  });

  it('连接检查的分项说明为英文', async () => {
    setLocale('en');
    const result = await runTextConnectionCheck({
      provider: ProviderSettingsSchema.parse({ baseUrl: 'https://api.example.com' }),
      apiKey: 'sk-test-placeholder',
      hasHostPermission: false,
      signal: new AbortController().signal,
    });
    const host = result.items.find((item) => item.key === 'hostPermission');
    expect(host?.message).toBe(
      'Access to https://api.example.com has not been granted. Click "Grant access" in Settings, then check again.',
    );
    for (const item of result.items) expect(item.message).not.toMatch(CJK);
  });
});
