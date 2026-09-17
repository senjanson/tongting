/**
 * 字幕正文入口：按内容识别格式（json3 / srv3 / WebVTT）并解析为 RawCaptionCue[]。
 * 只实现已有夹具的格式；未知格式抛出 CaptionParseError('unknown-format')。
 */
import {
  CaptionParseError,
  MAX_CAPTION_BODY_CHARS,
  type CaptionFormat,
  type CaptionParseResult,
} from './normalize';
import { parseJson3 } from './parse-json3';
import { parseSrv3 } from './parse-srv3';
import { parseVtt } from './parse-vtt';

export { CaptionParseError, MAX_CAPTION_BODY_CHARS, MAX_PARSED_CUES } from './normalize';
export type { CaptionFormat, CaptionParseResult, CaptionParseStats } from './normalize';
export { parseJson3 } from './parse-json3';
export { parseSrv3 } from './parse-srv3';
export { parseVtt } from './parse-vtt';

export function detectCaptionFormat(body: string): CaptionFormat | undefined {
  const head = body
    .replace(/^\ufeff/, '')
    .slice(0, 512)
    .trimStart();
  if (head.startsWith('{')) return 'json3';
  if (/^WEBVTT(?:[ \t\r\n]|$)/.test(head)) return 'vtt';
  if (/^(?:<\?xml[^>]*\?>\s*)?<timedtext\b/i.test(head)) return 'srv3';
  return undefined;
}

export function parseCaptionBody(body: string, hint?: CaptionFormat): CaptionParseResult {
  if (body.length > MAX_CAPTION_BODY_CHARS) throw new CaptionParseError('too-large');
  const format = detectCaptionFormat(body) ?? hint;
  switch (format) {
    case 'json3':
      return parseJson3(body);
    case 'srv3':
      return parseSrv3(body);
    case 'vtt':
      return parseVtt(body);
    default:
      throw new CaptionParseError('unknown-format');
  }
}
