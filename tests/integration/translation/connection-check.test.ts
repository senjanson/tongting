/**
 * 连接检查分项结果（真实 fetch + 模拟 sub2api）：T05、T06、权限、协议自动检测、流式。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderSettingsSchema, type ProviderSettings } from '@src/domain/settings';
import { runTextConnectionCheck } from '@src/providers/text/connection-check';
import { ConnectionCheckItemSchema } from '@src/messaging/ui-protocol';
import {
  MOCK_API_KEY,
  startMockSub2api,
  type MockSub2api,
} from '../../helpers/mock-sub2api/server';

const servers: MockSub2api[] = [];
async function server(options: Parameters<typeof startMockSub2api>[0] = {}) {
  const s = await startMockSub2api(options);
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function settings(
  s: MockSub2api | undefined,
  overrides: Partial<ProviderSettings> = {},
): ProviderSettings {
  return ProviderSettingsSchema.parse({
    baseUrl: s?.baseUrl ?? '',
    timeoutMs: 5_000,
    ...overrides,
  });
}

async function check(
  s: MockSub2api | undefined,
  params: {
    overrides?: Partial<ProviderSettings>;
    apiKey?: string;
    hasHostPermission?: boolean;
    includeStreaming?: boolean;
  } = {},
) {
  const result = await runTextConnectionCheck({
    provider: settings(s, params.overrides),
    apiKey: 'apiKey' in params ? params.apiKey : MOCK_API_KEY,
    hasHostPermission: params.hasHostPermission ?? true,
    signal: new AbortController().signal,
    includeStreaming: params.includeStreaming,
  });
  // 结果必须符合 UI 协议 schema，且不包含 Key 或完整 URL
  for (const item of result.items) ConnectionCheckItemSchema.parse(item);
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(MOCK_API_KEY);
  expect(serialized).not.toContain('/v1/');
  const byKey = Object.fromEntries(result.items.map((i) => [i.key, i]));
  return { result, byKey };
}

describe('runTextConnectionCheck', () => {
  it('verifies every item against a working service and detects Responses first in auto mode', async () => {
    const s = await server();
    const { result, byKey } = await check(s, { includeStreaming: true });
    expect(result.items.map((i) => i.key)).toEqual([
      'hostPermission',
      'reachability',
      'auth',
      'modelList',
      'model',
      'translation',
      'streaming',
    ]);
    expect(result.items.every((i) => i.status === 'verified')).toBe(true);
    expect(result.detectedProtocol).toBe('responses');
    expect(result.models).toEqual(['gpt-5.6-luna', 'gpt-5.6-terra']);
    expect(byKey.translation!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(s.requests.map((r) => r.endpoint)).toEqual(['models', 'responses', 'responses']);
    expect((s.requests[2]!.body as { stream?: boolean }).stream).toBe(true);
  });

  it('sends nothing when host permission is missing, and nothing for an invalid Base URL', async () => {
    const s = await server();
    const { byKey } = await check(s, { hasHostPermission: false });
    expect(byKey.hostPermission).toMatchObject({
      status: 'failed',
      reasonCode: 'host-permission-missing',
    });
    expect(byKey.translation!.status).toBe('unknown');
    expect(s.requests).toHaveLength(0);

    const bad = await check(undefined, { overrides: { baseUrl: 'http://api.example.com' } });
    expect(bad.byKey.reachability).toMatchObject({
      status: 'failed',
      reasonCode: 'base-url-insecure',
    });
  });

  it('T05: an invalid key fails auth and stops — no model or translation calls, nothing marked verified beyond reachability', async () => {
    const s = await server();
    const { result, byKey } = await check(s, { apiKey: 'wrong-fake-key' });
    expect(byKey.reachability!.status).toBe('verified');
    expect(byKey.auth).toMatchObject({ status: 'failed' });
    expect(result.items.filter((i) => i.status === 'verified').map((i) => i.key)).toEqual([
      'hostPermission',
      'reachability',
    ]);
    expect(s.requests).toHaveLength(1);

    const missingKey = await check(s, { apiKey: undefined });
    expect(missingKey.byKey.auth).toMatchObject({
      status: 'failed',
      reasonCode: 'api-key-missing',
    });
  });

  it('T05: model 403 is reported on the model item without claiming success', async () => {
    const s = await server({ allowedModels: ['gpt-5.6-luna'] });
    const { result, byKey } = await check(s, {
      overrides: { protocol: 'responses', model: 'gpt-5.6-terra' },
    });
    // 模型列表 200 只说明列表接口接受了 Key；翻译没有成功，不能标记为 verified
    expect(byKey.auth!.status).toBe('unknown');
    expect(byKey.auth!.message).toContain('模型列表接口接受');
    expect(byKey.model).toMatchObject({ status: 'failed', reasonCode: 'model-forbidden' });
    expect(byKey.translation!.status).toBe('failed');
    expect(result.detectedProtocol).toBeUndefined();
    expect(s.requestsTo('responses')).toHaveLength(1);
  });

  it('T06: model list unavailable, manual model still verified by a real call', async () => {
    const s = await server({ supportModels: false });
    const { result, byKey } = await check(s, { overrides: { model: 'gpt-5.6-luna' } });
    expect(byKey.modelList!.status).toBe('unsupported');
    expect(byKey.model!.status).toBe('verified');
    expect(byKey.translation!.status).toBe('verified');
    expect(result.models).toBeUndefined();
  });

  it('auto mode falls back to Chat only when the Responses endpoint is unsupported', async () => {
    const s = await server({ supportResponses: false });
    const { result, byKey } = await check(s);
    expect(result.detectedProtocol).toBe('chat');
    expect(byKey.translation!.message).toContain('Chat Completions');
    expect(s.requests.map((r) => r.endpoint)).toEqual(['models', 'responses', 'chat']);

    const neither = await server({ supportResponses: false, supportChat: false });
    const none = await check(neither);
    expect(none.byKey.translation!.status).toBe('unsupported');
    expect(none.result.detectedProtocol).toBeUndefined();
  });

  it('reports an unknown model as a model failure, and a service that ignores stream=true as streaming unsupported', async () => {
    const s = await server();
    const unknown = await check(s, { overrides: { model: 'gpt-imaginary', protocol: 'chat' } });
    expect(unknown.byKey.model).toMatchObject({ status: 'failed', reasonCode: 'model-not-found' });

    const s2 = await server();
    const probeText = JSON.stringify({
      translations: [{ id: 'probe-1', text: '安娜，下午3点前请不要开门。' }],
    });
    s2.enqueue(
      'responses',
      { kind: 'translate' },
      {
        kind: 'raw',
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: probeText }] }],
        }),
      },
    );
    const ignored = await check(s2, { includeStreaming: true });
    expect(ignored.byKey.translation!.status).toBe('verified');
    expect(ignored.byKey.streaming).toMatchObject({
      status: 'unsupported',
      reasonCode: 'stream-ignored',
    });
  });

  it('reports a rate-limited translation probe as failed with the reason, not as success', async () => {
    const s = await server();
    s.enqueue('responses', {
      kind: 'status',
      status: 429,
      headers: { 'retry-after': '7' },
      body: { error: { message: 'Rate limit reached' } },
    });
    const { byKey } = await check(s, { overrides: { protocol: 'responses' } });
    expect(byKey.translation).toMatchObject({ status: 'failed', reasonCode: 'rate-limited' });
    expect(byKey.model!.status).toBe('unknown');
  });

  it('#11: a hanging or redirected model list only fails modelList; the manual model is still probed and decides reachability', async () => {
    const s = await server();
    s.enqueue('models', { kind: 'hang' });
    const hung = await check(s, { overrides: { protocol: 'responses', timeoutMs: 3_000 } });
    expect(hung.byKey.modelList).toMatchObject({ status: 'failed', reasonCode: 'timeout' });
    expect(hung.byKey.reachability!.status).toBe('verified');
    expect(hung.byKey.reachability!.message).toContain('翻译接口有响应');
    expect(hung.byKey.translation!.status).toBe('verified');
    expect(hung.byKey.auth!.status).toBe('verified');
    expect(s.requestsTo('responses')).toHaveLength(1);

    const r = await server();
    r.enqueue('models', { kind: 'redirect', location: 'https://login.example.com/', status: 302 });
    const redirected = await check(r, { overrides: { protocol: 'responses' } });
    expect(redirected.byKey.modelList).toMatchObject({
      status: 'failed',
      reasonCode: 'redirect-blocked',
    });
    expect(redirected.byKey.translation!.status).toBe('verified');
  }, 15_000);

  it('#11: when both the model list and the probe get no response, reachability fails with the reason', async () => {
    const s = await server();
    s.enqueue('models', { kind: 'hang' });
    s.enqueue('responses', { kind: 'hang' });
    const { byKey } = await check(s, { overrides: { protocol: 'responses', timeoutMs: 3_000 } });
    expect(byKey.reachability).toMatchObject({ status: 'failed', reasonCode: 'timeout' });
    expect(byKey.translation!.status).toBe('failed');
    expect(byKey.model!.status).toBe('unknown');
  }, 15_000);

  it('#12: describes a degraded structured-output mode truthfully', async () => {
    const s = await server({ rejectJsonSchema: true });
    const { byKey } = await check(s, { overrides: { protocol: 'chat' } });
    expect(byKey.translation).toMatchObject({
      status: 'verified',
      reasonCode: 'format-json_object',
    });
    expect(byKey.translation!.message).toContain('JSON 模式');
    expect(byKey.translation!.message).not.toContain('json_schema（严格模式）');
  });

  it('#12: distinguishes a chat stream that ended with finish_reason only from one with [DONE]', async () => {
    const s = await server();
    const probe = JSON.stringify({
      translations: [{ id: 'probe-1', text: '安娜，请不要在下午3点前开门。' }],
    });
    s.enqueue(
      'chat',
      { kind: 'translate' },
      {
        kind: 'sse',
        chunks: [
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: probe } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
        ],
        end: 'close',
      },
    );
    const noDone = await check(s, { overrides: { protocol: 'chat' }, includeStreaming: true });
    expect(noDone.byKey.streaming).toMatchObject({
      status: 'verified',
      reasonCode: 'stream-no-done',
    });
    expect(noDone.byKey.streaming!.message).toContain('没有收到 [DONE]');

    const s2 = await server();
    const withDone = await check(s2, { overrides: { protocol: 'chat' }, includeStreaming: true });
    expect(withDone.byKey.streaming!.status).toBe('verified');
    expect(withDone.byKey.streaming!.reasonCode).toBeUndefined();
    expect(withDone.byKey.streaming!.message).toContain('[DONE]');
  });

  it('propagates cancellation', async () => {
    const s = await server();
    s.enqueue('models', { kind: 'hang' });
    const controller = new AbortController();
    const promise = runTextConnectionCheck({
      provider: settings(s),
      apiKey: MOCK_API_KEY,
      hasHostPermission: true,
      signal: controller.signal,
    });
    await s.waitFor(() => s.inflight() === 1);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ info: { category: 'cancelled' } });
    await s.waitFor(() => s.inflight() === 0);
  });
});
