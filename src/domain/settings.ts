import { z } from 'zod';
import { DEFAULT_TARGET_LANGUAGE, defaultTargetLanguageFor } from './languages';
import { DEFAULT_SEARCH_KEYWORD_LANGUAGE, SearchLanguageTagSchema } from './search';
import { DEFAULT_TEXT_MODEL } from './translation-models';

export const SETTINGS_SCHEMA_VERSION = 2;

export const TranslationStyleSchema = z.enum(['natural', 'faithful', 'concise', 'terminology']);
export type TranslationStyle = z.infer<typeof TranslationStyleSchema>;

export const TextProtocolSchema = z.enum(['auto', 'responses', 'chat']);
export type TextProtocol = z.infer<typeof TextProtocolSchema>;

/** 实际显示的界面语言（见 src/i18n/locale.ts）。 */
export const LocaleSchema = z.enum(['zh-CN', 'en']);
/** 界面语言偏好：auto 跟随浏览器界面语言（中文含繁体显示中文，其余英文）。 */
export const UiLocaleSchema = z.enum(['auto', 'zh-CN', 'en']);
/** 外观主题：auto 跟随系统明暗（浅色纸墨、深色夜墨）。 */
export const UiThemeSchema = z.enum(['auto', 'paper', 'ink', 'cinema', 'wave']);
export type UiThemePreference = z.infer<typeof UiThemeSchema>;

export const GlossaryEntrySchema = z.object({
  source: z.string().min(1).max(100),
  target: z.string().min(1).max(100),
});
export type GlossaryEntry = z.infer<typeof GlossaryEntrySchema>;

export const CaptionSettingsSchema = z.object({
  /** 是否在播放器上显示译听字幕层。 */
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
  /** 配音会话内全程静音原声；旧配置缺少此字段时也采用静音。 */
  originalMode: z.enum(['mute', 'mix']).default('mute'),
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
  model: z.string().max(200).default(DEFAULT_TEXT_MODEL),
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

export const SearchSettingsSchema = z.object({
  /** AI 搜索的输入、标签与释义语言；缺省表示跟随 targetLanguage。 */
  userLanguage: SearchLanguageTagSchema.optional(),
  /** AI 搜索生成的搜索词语言。 */
  keywordLanguage: SearchLanguageTagSchema.default(DEFAULT_SEARCH_KEYWORD_LANGUAGE),
});
export type SearchSettings = z.infer<typeof SearchSettingsSchema>;

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
  /** 旧设置没有此字段时取默认值，无需迁移。 */
  search: SearchSettingsSchema.default(SearchSettingsSchema.parse({})),
  prefetch: z.boolean().default(true),
  /** 录播先准备译文再播放；连续模式保留边播边译的行为。 */
  playbackMode: z.enum(['buffered', 'continuous']).default('buffered'),
  bufferSeconds: z.union([z.literal(5), z.literal(10), z.literal(20)]).default(10),
  pauseDubWithVideo: z.boolean().default(true),
  cacheTranslations: z.boolean().default(true),
  glossary: z.array(GlossaryEntrySchema).max(500).default([]),
  /** 默认保存在扩展专属 IndexedDB；主动取消后仅存于临时浏览器会话。 */
  rememberCredentials: z.boolean().default(true),
  layout: z.enum(['sidebar']).default('sidebar'),
  /** 界面语言：auto 跟随浏览器界面语言。只影响界面文案，不进入翻译指纹。 */
  uiLocale: UiLocaleSchema.default('auto'),
  /** 外观主题：扩展页面与播放器字幕层共用。只影响外观，不进入翻译指纹。 */
  uiTheme: UiThemeSchema.default('auto'),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** targetLanguage 用于首次安装时按界面语言给出默认值；省略则使用内置默认。 */
export function defaultSettings(targetLanguage?: string): Settings {
  return SettingsSchema.parse({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    ...(targetLanguage ? { targetLanguage } : {}),
  });
}

/** 首次安装、设置无法使用与「恢复默认设置」共用的默认值：目标语言按浏览器界面语言选择。 */
export function initialSettings(uiLanguage: string | undefined): Settings {
  return defaultSettings(defaultTargetLanguageFor(uiLanguage));
}

type NestedSettingsKey = 'captions' | 'audio' | 'provider' | 'asr' | 'tts' | 'search';

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
    search: { ...base.search, ...patch.search },
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
