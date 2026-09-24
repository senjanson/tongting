/**
 * 真实 sub2api 冒烟测试（会产生真实计费调用）。只通过 `pnpm smoke:sub2api` 显式运行。
 *
 * 配置：项目根目录 `.env.local`（已被 .gitignore 忽略），或同名环境变量：
 *   SUB2API_BASE_URL   必填，例如 https://api.example.com 或 https://api.example.com/v1
 *   SUB2API_API_KEY    必填
 *   SUB2API_MODELS     可选，逗号分隔，默认 gpt-5.6-luna
 *   SUB2API_PROTOCOL   可选，responses | chat | both（默认 both）
 *   SUB2API_TTS_MODEL  可选，设置后额外实测一次语音合成（SUB2API_TTS_VOICE 可选）
 *   SUB2API_ASR_MODEL  可选，设置后额外实测一次语音识别（上传本仓库 5 秒英文合成语音样本）
 *
 * 调用量（每个模型 × 协议）：1 次非流式批量翻译（英/日/韩 3 句）+ 1 次流式翻译；
 * 另加一次分项连接检查（模型列表 + 1~2 次极短翻译 + 1 次流式）。
 *
 * 输出只包含脱敏后的 origin、模型名、状态、延迟与译文质量观察，绝不打印 Key。
 * 能力矩阵只反映本次实测结果，不代表其他模型、分组或时间点的能力。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redactUrl, toAppErrorInfo } from '@src/domain/errors';
import { ProviderSettingsSchema } from '@src/domain/settings';
import { normalizeBaseUrl } from '@src/providers/text/base-url';
import { runTextConnectionCheck } from '@src/providers/text/connection-check';
import { createTextProvider } from '@src/providers/text/factory';
import { discoverModels } from '@src/providers/text/models';
import type { TranslateBatchInput } from '@src/providers/text/types';
import { synthesizeSpeech } from '@src/providers/tts/sub2api-speech';
import { createSub2apiAsrProvider } from '@src/providers/asr/sub2api-client';

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const file = resolve(__dirname, '../../.env.local');
  if (existsSync(file)) {
    for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line
        .slice(0, eq)
        .replace(/^export\s+/, '')
        .trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  }
  for (const key of [
    'SUB2API_BASE_URL',
    'SUB2API_API_KEY',
    'SUB2API_MODELS',
    'SUB2API_PROTOCOL',
    'SUB2API_TTS_MODEL',
    'SUB2API_TTS_VOICE',
    'SUB2API_ASR_MODEL',
  ]) {
    const fromProcess = process.env[key];
    if (fromProcess) out[key] = fromProcess;
  }
  return out;
}

const env = loadEnv();
const baseUrl = env.SUB2API_BASE_URL?.trim() ?? '';
const apiKey = env.SUB2API_API_KEY?.trim() ?? '';
const configured = Boolean(baseUrl && apiKey);
const ttsModel = env.SUB2API_TTS_MODEL?.trim() ?? '';
const ttsVoice = env.SUB2API_TTS_VOICE?.trim() ?? '';
const asrModel = env.SUB2API_ASR_MODEL?.trim() ?? '';
const models = (env.SUB2API_MODELS ?? 'gpt-5.6-luna')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const protocolSetting = (env.SUB2API_PROTOCOL ?? 'both').trim().toLowerCase();
const protocols: ('responses' | 'chat')[] =
  protocolSetting === 'responses'
    ? ['responses']
    : protocolSetting === 'chat'
      ? ['chat']
      : ['responses', 'chat'];

/** 输出前的最后一道防线：任何文本里出现 Key 都替换掉。 */
function safe(text: string): string {
  let out = text;
  if (apiKey) out = out.split(apiKey).join('[REDACTED]');
  return out;
}

function log(line: string): void {
  console.log(safe(line));
}

const SAMPLES = [
  {
    id: 'en-1',
    lang: 'en',
    text: 'Dr. Emily Carter said the bridge will not open until March 3, 2027.',
    numbers: ['3', '2027'],
  },
  { id: 'ja-1', lang: 'ja', text: '田中さんは昨日、3キロも走らなかったそうです。', numbers: ['3'] },
  {
    id: 'ko-1',
    lang: 'ko',
    text: '김민수 씨는 금요일 회의에 참석하지 않을 거예요. 회의는 10시 30분에 시작해요.',
    numbers: ['10', '30'],
  },
] as const;

const NEGATION = /不|没|沒|别|別|勿|未|无|無|非/;

interface MatrixRow {
  model: string;
  protocol: string;
  mode: 'json' | 'stream';
  status: 'verified' | 'failed';
  latencyMs?: number;
  note: string;
}

const matrix: MatrixRow[] = [];

function batchInput(): TranslateBatchInput {
  return {
    items: SAMPLES.map((s) => ({ id: s.id, text: s.text })),
    context: [],
    sourceLanguage: 'auto',
    targetLanguage: 'zh-CN',
    style: 'natural',
    glossary: [],
  };
}

function qualityNotes(items: { id: string; text: string }[]): string {
  return SAMPLES.map((sample) => {
    const got = items.find((i) => i.id === sample.id)?.text;
    if (!got) return `${sample.id}:缺失`;
    const numbersKept = sample.numbers.every((n) => got.includes(n));
    const negationKept = NEGATION.test(got);
    return `${sample.id}:数字${numbersKept ? '✓' : '✗'}否定${negationKept ? '✓' : '✗'}`;
  }).join(' ');
}

describe.runIf(!configured)('sub2api 冒烟测试未配置', () => {
  it('未配置，跳过（不会发出任何网络请求）', () => {
    console.log(
      '[smoke:sub2api] 未配置 SUB2API_BASE_URL / SUB2API_API_KEY（.env.local 或环境变量），跳过真实服务测试。',
    );
  });
});

describe.skipIf(!configured)('sub2api 真实冒烟测试', () => {
  const normalized = normalizeBaseUrl(baseUrl);
  const origin = normalized.ok ? normalized.origin : redactUrl(baseUrl);

  it('Base URL 规范化', () => {
    if (!normalized.ok) log(`[smoke] Base URL 无效：${normalized.error.message}`);
    expect(normalized.ok).toBe(true);
    log(
      `[smoke] 服务 origin：${origin}；模型：${models.join(', ')}；协议：${protocols.join(', ')}`,
    );
  });

  it('模型列表（仅说明服务列出了哪些 ID，不代表都有权限）', async () => {
    const started = Date.now();
    try {
      const list = await discoverModels({
        baseUrl,
        apiKey,
        signal: AbortSignal.timeout(30_000),
        timeoutMs: 20_000,
      });
      log(`[smoke] 模型列表：${list.length} 个，${Date.now() - started} ms`);
      for (const model of models)
        log(
          `[smoke]   ${model}：${list.includes(model) ? '在列表中' : '不在列表中（仍会实测调用）'}`,
        );
    } catch (error) {
      const info = toAppErrorInfo(error);
      log(`[smoke] 模型列表失败（不阻断后续实测）：${info.code} ${info.message}`);
    }
  });

  for (const model of models) {
    for (const protocol of protocols) {
      it(`${model} × ${protocol}：非流式批量翻译（英/日/韩，人名/数字/否定）`, async () => {
        const provider = createTextProvider({
          baseUrl,
          apiKey,
          protocol,
          model,
          reasoningEffort: 'omit',
          streaming: false,
        });
        try {
          const result = await provider.translateBatch(batchInput(), {
            signal: AbortSignal.timeout(90_000),
            timeoutMs: 60_000,
          });
          const note = `${qualityNotes(result.items)} 修复${result.repairAttempts}次 usage=${JSON.stringify(result.usage ?? {})} 实际模型=${result.model}`;
          matrix.push({
            model,
            protocol,
            mode: 'json',
            status: 'verified',
            latencyMs: result.latencyMs,
            note,
          });
          for (const item of result.items) log(`[smoke]   ${item.id} → ${item.text}`);
        } catch (error) {
          const info = toAppErrorInfo(error);
          matrix.push({
            model,
            protocol,
            mode: 'json',
            status: 'failed',
            note: `${info.category}/${info.code}: ${info.message}${info.detail ? `（${info.detail}）` : ''}`,
          });
        }
      });

      it(`${model} × ${protocol}：流式翻译（需收到结束事件）`, async () => {
        const provider = createTextProvider({
          baseUrl,
          apiKey,
          protocol,
          model,
          reasoningEffort: 'omit',
          streaming: true,
        });
        let partials = 0;
        try {
          const result = await provider.translateBatch(batchInput(), {
            signal: AbortSignal.timeout(90_000),
            timeoutMs: 60_000,
            onPartial: () => {
              partials++;
            },
          });
          matrix.push({
            model,
            protocol,
            mode: 'stream',
            status: 'verified',
            latencyMs: result.latencyMs,
            note: `partial ${partials} 次；${qualityNotes(result.items)}`,
          });
        } catch (error) {
          const info = toAppErrorInfo(error);
          matrix.push({
            model,
            protocol,
            mode: 'stream',
            status: 'failed',
            note: `${info.category}/${info.code}: ${info.message}`,
          });
        }
      });
    }
  }

  it('分项连接检查（与扩展设置页使用同一实现）', async () => {
    const result = await runTextConnectionCheck({
      provider: ProviderSettingsSchema.parse({
        baseUrl,
        protocol: protocols.length === 2 ? 'auto' : protocols[0],
        model: models[0],
        timeoutMs: 60_000,
      }),
      apiKey,
      hasHostPermission: true,
      signal: AbortSignal.timeout(180_000),
      includeStreaming: true,
    });
    log(`[smoke] 连接检查（模型 ${models[0]}，检测到协议：${result.detectedProtocol ?? '无'}）`);
    for (const item of result.items) {
      log(
        `[smoke]   ${item.key.padEnd(14)} ${item.status.padEnd(11)} ${item.latencyMs !== undefined ? `${item.latencyMs}ms ` : ''}${item.message}`,
      );
    }
    const serialized = JSON.stringify(result);
    expect(serialized.includes(apiKey)).toBe(false);
  });

  it.runIf(!!ttsModel)('语音合成（/v1/audio/speech）返回可用音频', async () => {
    const started = Date.now();
    try {
      const result = await synthesizeSpeech({
        baseUrl,
        apiKey,
        model: ttsModel,
        voice: ttsVoice,
        text: '你好，这是译听的语音合成测试。',
        speed: 1,
        signal: AbortSignal.timeout(60_000),
      });
      log(
        `[smoke] TTS ${ttsModel} verified ${result.latencyMs}ms ${result.audio.byteLength} bytes ${result.contentType}`,
      );
      expect(result.audio.byteLength).toBeGreaterThan(1_000);
    } catch (error) {
      const info = toAppErrorInfo(error);
      log(`[smoke] TTS ${ttsModel} failed ${Date.now() - started}ms ${info.code} ${info.message}`);
      throw error;
    }
  });

  it.runIf(!!asrModel)('语音识别（/v1/audio/transcriptions）识别英文样本', async () => {
    const wav = readFileSync(
      resolve(__dirname, '../../services/asr-local/tests/fixtures/en_5s.wav'),
    );
    const provider = createSub2apiAsrProvider({ baseUrl, apiKey, model: asrModel });
    const started = Date.now();
    try {
      const result = await provider.transcribe(
        wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
        { language: 'en', signal: AbortSignal.timeout(90_000), timeoutMs: 90_000 },
      );
      log(
        `[smoke] ASR ${asrModel} verified ${Date.now() - started}ms 文本：${result.text.slice(0, 120)}`,
      );
      expect(result.text.trim().length).toBeGreaterThan(0);
    } catch (error) {
      const info = toAppErrorInfo(error);
      log(`[smoke] ASR ${asrModel} failed ${Date.now() - started}ms ${info.code} ${info.message}`);
      throw error;
    }
  });

  it('能力矩阵汇总（至少一个模型 × 协议的非流式翻译实测成功）', () => {
    log(`[smoke] ===== 能力矩阵（${new Date().toISOString()}，${origin}）=====`);
    for (const row of matrix) {
      log(
        `[smoke] ${row.model} | ${row.protocol.padEnd(9)} | ${row.mode.padEnd(6)} | ${row.status.padEnd(8)} | ${row.latencyMs !== undefined ? `${row.latencyMs}ms` : '-'} | ${row.note}`,
      );
    }
    expect(matrix.some((r) => r.mode === 'json' && r.status === 'verified')).toBe(true);
  });
});
