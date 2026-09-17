import { z } from 'zod';
import { DEFAULT_TARGET_LANGUAGE } from './languages';

export const SETTINGS_SCHEMA_VERSION = 1;

export const TranslationStyleSchema = z.enum(['natural', 'faithful', 'concise', 'terminology']);
export type TranslationStyle = z.infer<typeof TranslationStyleSchema>;

export const TextProtocolSchema = z.enum(['auto', 'responses', 'chat']);
export type TextProtocol = z.infer<typeof TextProtocolSchema>;

export const GlossaryEntrySchema = z.object({
  source: z.string().min(1).max(100),
  target: z.string().min(1).max(100),
});
export type GlossaryEntry = z.infer<typeof GlossaryEntrySchema>;

export const CaptionSettingsSchema = z.object({
  /** 是否在播放器上显示同听字幕层。 */
  enabled: z.boolean().default(true),
  bilingual: z.boolean().default(true),
  position: z.enum(['bottom', 'middle', 'top']).default('bottom'),
  fontSizePx: z.number().int().min(12).max(48).default(22),
  backgroundOpacity: z.number().min(0).max(1).default(0.75),
  /** 字幕显示时间偏移，正数表示延后显示。 */
  offsetMs: z.number().int().min(-10_000).max(10_000).default(0),
});
export type CaptionSettings = z.infer<typeof CaptionSettingsSchema>;

export const AudioSettingsSchema = z.object({
  /** 原声音量（0..1），仅在配音/捕获模式下由扩展调整。 */
  originalVolume: z.number().min(0).max(1).default(1),
  dubVolume: z.number().min(0).max(1).default(1),
  /** 系统语音名称；为空表示按目标语言自动选择实际可用声音。 */
  voiceName: z.string().max(200).default(''),
  rate: z.number().min(0.5).max(2).default(1),
  duckOriginal: z.boolean().default(true),
  /** 配音播放时原声相对系数。 */
  duckLevel: z.number().min(0).max(1).default(0.3),
});
export type AudioSettings = z.infer<typeof AudioSettingsSchema>;

export const ProviderSettingsSchema = z.object({
  /** sub2api Base URL，例如 https://api.example.com 或 https://api.example.com/v1 */
  baseUrl: z.string().max(500).default(''),
  protocol: TextProtocolSchema.default('auto'),
  /** 自动检测后确定的协议；配置变化时清空。 */
  detectedProtocol: z.enum(['responses', 'chat']).optional(),
  model: z.string().max(200).default('gpt-5.6-terra'),
  /** 推理强度参数：omit 表示不发送该字段。需实测服务是否接受。 */
  reasoningEffort: z.enum(['omit', 'none', 'low']).default('omit'),
  streaming: z.boolean().default(false),
  timeoutMs: z.number().int().min(3_000).max(120_000).default(15_000),
});
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;

export const AsrSettingsSchema = z.object({
  backend: z.enum(['none', 'local', 'sub2api']).default('none'),
  /** 本地识别服务地址，仅允许 loopback。 */
  localUrl: z.string().max(200).default('http://127.0.0.1:8765'),
  /** sub2api 语音识别模型（需实测）。 */
  sub2apiModel: z.string().max(200).default(''),
  /** 识别分段长度。 */
  segmentMs: z.number().int().min(2_000).max(15_000).default(5_000),
});
export type AsrSettings = z.infer<typeof AsrSettingsSchema>;

export const TtsSettingsSchema = z.object({
  backend: z.enum(['system', 'sub2api', 'none']).default('system'),
  sub2apiModel: z.string().max(200).default(''),
  sub2apiVoice: z.string().max(100).default(''),
});
export type TtsSettings = z.infer<typeof TtsSettingsSchema>;

export const SettingsSchema = z.object({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),
  sourceLanguage: z.string().max(20).default('auto'),
  targetLanguage: z.string().max(20).default(DEFAULT_TARGET_LANGUAGE),
  outputMode: z.enum(['subtitle', 'subtitle-voice']).default('subtitle'),
  style: TranslationStyleSchema.default('natural'),
  sourceStrategy: z.enum(['captions-first', 'captions-only', 'asr-only']).default('captions-first'),
  captions: CaptionSettingsSchema.default(CaptionSettingsSchema.parse({})),
  audio: AudioSettingsSchema.default(AudioSettingsSchema.parse({})),
  provider: ProviderSettingsSchema.default(ProviderSettingsSchema.parse({})),
  asr: AsrSettingsSchema.default(AsrSettingsSchema.parse({})),
  tts: TtsSettingsSchema.default(TtsSettingsSchema.parse({})),
  prefetch: z.boolean().default(true),
  pauseDubWithVideo: z.boolean().default(true),
  cacheTranslations: z.boolean().default(true),
  glossary: z.array(GlossaryEntrySchema).max(500).default([]),
  /** 是否把凭证保存在本机（chrome.storage.local）；否则仅保存在浏览器会话。 */
  rememberCredentials: z.boolean().default(false),
  layout: z.enum(['sidebar']).default('sidebar'),
});
export type Settings = z.infer<typeof SettingsSchema>;

export function defaultSettings(): Settings {
  return SettingsSchema.parse({ schemaVersion: SETTINGS_SCHEMA_VERSION });
}

type NestedSettingsKey = 'captions' | 'audio' | 'provider' | 'asr' | 'tts';

/** 深层部分更新，用于 settings/update 命令。缺失的键表示「不修改」。 */
export type SettingsPatch = Partial<Omit<Settings, 'schemaVersion' | NestedSettingsKey>> & {
  [K in NestedSettingsKey]?: Partial<Settings[K]>;
};

/**
 * 去掉字段默认值并变为可选。zod 的 .partial() 会保留 .default()，解析缺失键时仍会填入默认值，
 * 导致一次局部更新把其他设置重置；因此补丁 schema 必须基于去掉默认值的字段构造。
 */
function toPatchSchema(schema: z.ZodObject): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    let inner = field as z.ZodType;
    while (inner instanceof z.ZodDefault) inner = inner.unwrap() as z.ZodType;
    if (inner instanceof z.ZodObject) inner = toPatchSchema(inner);
    shape[key] = inner.optional();
  }
  return z.object(shape);
}

export const SettingsPatchSchema = toPatchSchema(
  SettingsSchema.omit({ schemaVersion: true }),
) as unknown as z.ZodType<SettingsPatch, SettingsPatch>;

export function applySettingsPatch(base: Settings, patch: SettingsPatch): Settings {
  const merged = {
    ...base,
    ...patch,
    captions: { ...base.captions, ...patch.captions },
    audio: { ...base.audio, ...patch.audio },
    provider: { ...base.provider, ...patch.provider },
    asr: { ...base.asr, ...patch.asr },
    tts: { ...base.tts, ...patch.tts },
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  };
  // 服务地址或协议选择变化时，旧的协议检测结果不再可信。
  const baseUrlChanged =
    patch.provider?.baseUrl !== undefined && patch.provider.baseUrl !== base.provider.baseUrl;
  const protocolChanged =
    patch.provider?.protocol !== undefined && patch.provider.protocol !== base.provider.protocol;
  if ((baseUrlChanged || protocolChanged) && patch.provider?.detectedProtocol === undefined) {
    delete merged.provider.detectedProtocol;
  }
  return SettingsSchema.parse(merged);
}

/**
 * 影响译文内容的设置指纹。变化时 configRevision 递增，旧翻译任务失效。
 * 字幕外观、音量等不影响译文的设置不计入。
 */
export function translationFingerprint(s: Settings): string {
  return JSON.stringify([
    s.sourceLanguage,
    s.targetLanguage,
    s.style,
    s.provider.baseUrl,
    s.provider.protocol,
    s.provider.model,
    s.provider.reasoningEffort,
    s.glossary,
  ]);
}
