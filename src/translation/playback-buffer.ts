import type { Cue, TimeRange } from '../domain/cue';

/** Silence counts as ready only inside a source range that was actually read. */
export function translatedUntil(
  positionMs: number,
  sourceRanges: readonly TimeRange[],
  cues: readonly Cue[],
): number {
  const range = sourceRanges.find((r) => r.startMs <= positionMs + 1 && r.endMs > positionMs);
  if (!range) return positionMs;
  let end = range.endMs;
  for (const cue of cues) {
    if (cue.endMs <= positionMs || cue.startMs >= end) continue;
    const translated = cue.translationState === 'done' && !!cue.translatedText?.trim();
    const sameLanguage = cue.translationState === 'skipped';
    if (cue.stability !== 'final' || (!translated && !sameLanguage))
      end = Math.min(end, Math.max(positionMs, cue.startMs));
  }
  return end;
}
