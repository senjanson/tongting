/** 优先选择字幕翻译所需的通用轻量文本模型；只在服务实际返回的候选中推荐。 */
export const DEFAULT_TEXT_MODEL = 'gpt-5.6-luna';

const PREFERRED_MODELS = [
  DEFAULT_TEXT_MODEL,
  'gpt-5.6-terra',
  'gpt-5.6',
  'gpt-5.6-sol',
  'gpt-6',
  'gpt-6-astra',
];

function eligibleVersion(model: string): [number, number] | undefined {
  if (/(?:image|audio|realtime|embedding|moderation|auto[-_]review)/i.test(model)) return undefined;
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:$|-)/i.exec(model);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6) ? [major, minor] : undefined;
}

export function translationModelCandidates(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))]
    .filter((model) => eligibleVersion(model) !== undefined)
    .sort((a, b) => {
      const [aMajor, aMinor] = eligibleVersion(a)!;
      const [bMajor, bMinor] = eligibleVersion(b)!;
      return aMajor - bMajor || aMinor - bMinor || a.localeCompare(b, 'en', { numeric: true });
    });
}

export function recommendedTranslationModel(models: readonly string[]): string | undefined {
  const available = new Set(translationModelCandidates(models));
  return PREFERRED_MODELS.find((model) => available.has(model));
}
