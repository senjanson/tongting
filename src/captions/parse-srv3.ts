/**
 * YouTube timedtext srv3（format="3" XML）解析。
 *
 * 已知结构（公开格式，待真实样本核对）：
 * <timedtext format="3"><body>
 *   <p t="160" d="4000" w="1"><s ac="0">hello</s><s t="400" ac="0"> world</s></p>
 *   <p t="2000" d="2160" w="1" a="1">&#10;</p>
 *   <p t="5000" d="3000">Manual &amp; caption<br/>second line</p>
 * </body></timedtext>
 *
 * 不依赖 DOMParser（service worker 中不可用）；只识别 <p> 与其中的 <s>/<br>，其他标签剥离。
 * 实体只解码一层，解码结果作为纯文本。
 */
import {
  CaptionParseError,
  MAX_CAPTION_BODY_CHARS,
  MAX_RAW_EVENTS,
  emptyStats,
  finalizeCandidates,
  type CaptionParseResult,
  type CueCandidate,
} from './normalize';
import { decodeEntities } from './text';

function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of raw.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs.set(m[1]!, m[2] ?? m[3] ?? '');
  }
  return attrs;
}

function intAttr(attrs: Map<string, string>, name: string): number | undefined {
  const v = attrs.get(name);
  if (v === undefined || !/^-?\d+(?:\.\d+)?$/.test(v.trim())) return undefined;
  return Number(v);
}

function innerText(xml: string): string {
  // <br> → 换行；其他标签（<s>、<font> 等）剥离，只保留文字。
  const withBreaks = xml.replace(/<br\s*\/?>/gi, '\n');
  // [^<>] 保证遇到下一个 < 就停止，避免大量未闭合 < 时的平方级回溯。
  const stripped = withBreaks.replace(/<[^<>]*>/g, '');
  return decodeEntities(stripped);
}

/**
 * 线性扫描 <p ...>...</p>。未闭合的 <p> 以下一个 <p 或正文结束为界。
 * 不用 `<p…>([\s\S]*?)</p>` 这类正则：大量未闭合 <p> 时正则会反复向后搜索，耗时呈平方级增长。
 */
export function* scanSrv3Paragraphs(body: string): Generator<{ attrs: string; inner: string }> {
  const openRe = /<p(?=[\s/>])/gi;
  const closeRe = /<\/p\s*>/gi;
  let closeIdx = -2;
  let pending = openRe.exec(body);
  while (pending) {
    const tagStart = pending.index;
    const gt = body.indexOf('>', tagStart);
    if (gt < 0) return;
    const selfClosing = body[gt - 1] === '/';
    const attrs = body.slice(tagStart + 2, selfClosing ? gt - 1 : gt);
    openRe.lastIndex = gt + 1;
    const next = openRe.exec(body);
    if (selfClosing) {
      yield { attrs, inner: '' };
      pending = next;
      continue;
    }
    if (closeIdx !== -1 && closeIdx < gt + 1) {
      closeRe.lastIndex = gt + 1;
      closeIdx = closeRe.exec(body)?.index ?? -1;
    }
    const contentEnd =
      closeIdx >= 0 && (!next || closeIdx < next.index)
        ? closeIdx
        : next
          ? next.index
          : body.length;
    yield { attrs, inner: body.slice(gt + 1, contentEnd) };
    pending = next;
  }
}

export function parseSrv3(body: string): CaptionParseResult {
  if (body.length > MAX_CAPTION_BODY_CHARS) throw new CaptionParseError('too-large');
  if (!/<timedtext\b/i.test(body)) throw new CaptionParseError('invalid-structure');
  const formatAttr = /<timedtext\b([^>]*)>/i.exec(body)?.[1];
  if (formatAttr !== undefined) {
    const fmt = parseAttributes(formatAttr).get('format');
    if (fmt !== undefined && fmt !== '3') throw new CaptionParseError('invalid-structure');
  }

  const stats = emptyStats();
  const candidates: Array<CueCandidate & { win: string | undefined }> = [];
  const lastByWindow = new Map<string | undefined, CueCandidate>();
  let count = 0;

  for (const p of scanSrv3Paragraphs(body)) {
    if (++count > MAX_RAW_EVENTS) throw new CaptionParseError('invalid-structure');
    if (p.attrs.length > 2_000) {
      stats.rejected++;
      continue;
    }
    const attrs = parseAttributes(p.attrs);
    const start = intAttr(attrs, 't');
    if (start === undefined) {
      stats.rejected++;
      continue;
    }
    const duration = intAttr(attrs, 'd');
    const end = duration !== undefined && duration > 0 ? start + duration : undefined;
    const text = innerText(p.inner);
    const win = attrs.get('w');
    const append = attrs.get('a') === '1';

    if (append) {
      if (!text.trim()) continue;
      const target = lastByWindow.get(win);
      if (target) {
        target.text += text;
        if (end !== undefined) target.endMs = Math.max(target.endMs ?? end, end);
        continue;
      }
    }
    if (!text.trim()) continue;
    const cand = { startMs: start, endMs: end, text, win };
    candidates.push(cand);
    lastByWindow.set(win, cand);
  }

  return finalizeCandidates(
    'srv3',
    candidates.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
    stats,
  );
}
