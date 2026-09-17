/**
 * 字幕文本工具：实体解码、空白/控制字符清洗、跨脚本拼接、分词与稳定 id。
 *
 * 所有输出都是纯文本；调用方必须以 textContent 渲染，不得作为 HTML 插入。
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  lrm: '\u200e',
  rlm: '\u200f',
  shy: '',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  deg: '°',
  times: '×',
  divide: '÷',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  iexcl: '¡',
  iquest: '¿',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  aacute: 'á',
  ccedil: 'ç',
  ntilde: 'ñ',
  ouml: 'ö',
  uuml: 'ü',
  auml: 'ä',
  szlig: 'ß',
  hearts: '♥',
  sung: '♪',
};

/**
 * 解码 HTML/XML 实体，只解码一层：`&amp;lt;` → `&lt;`（仍为字面文本）。
 * 无效码点替换为 U+FFFD；未知命名实体原样保留。
 */
export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(
    /&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,9}|[A-Za-z][A-Za-z0-9]{1,31});/g,
    (match, body: string) => {
      if (body.startsWith('#')) {
        const hex = body[1] === 'x' || body[1] === 'X';
        const cp = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
          return '\ufffd';
        return String.fromCodePoint(cp);
      }
      const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
      return named ?? match;
    },
  );
}

// C0/C1 控制字符（保留 \n，\t 之后会转为空格）、零宽字符、BOM，以及可改变显示顺序的 bidi 嵌入/覆盖/隔离字符。
const CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\ufeff\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const SPACE_LIKE = /[\t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

/** 不以空格分词的脚本：中日文、泰文等。 */
const NO_SPACE_CHAR =
  /[\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u31a0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u0e00-\u0e7f\u0e80-\u0eff\u1780-\u17ff\u1000-\u109f]/;

export function isNoSpaceChar(ch: string | undefined): boolean {
  return !!ch && NO_SPACE_CHAR.test(ch);
}

/** 拼接两段字幕文本：拉丁等脚本之间补一个空格，中日文等无空格脚本直接连接。 */
export function joinCaptionText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const last = a[a.length - 1];
  const first = b[0];
  if (isNoSpaceChar(last) || isNoSpaceChar(first)) return a + b;
  return `${a} ${b}`;
}

/**
 * 清洗字幕文本：统一换行、去控制字符与零宽字符、合并空白，并把多行按脚本规则拼成一行。
 */
export function normalizeCaptionText(input: string): string {
  const lines = input
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(SPACE_LIKE, ' ')
    .split('\n');
  let out = '';
  for (const raw of lines) {
    const line = raw.replace(/ {2,}/g, ' ').trim();
    if (line) out = joinCaptionText(out, line);
  }
  return out;
}

/** 与 normalizeCaptionText 相同，但保留行结构（用于滚动字幕逐行比较）。 */
export function normalizeCaptionLines(input: string): string[] {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(SPACE_LIKE, ' ')
    .split('\n')
    .map((l) => l.replace(/ {2,}/g, ' ').trim())
    .filter((l) => l.length > 0);
}

/** 截断到最大长度，不切断代理对。 */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

export interface CaptionToken {
  text: string;
  /** 原文中该 token 前是否有空白。 */
  spaceBefore: boolean;
}

const TOKEN_RE = new RegExp(
  `${NO_SPACE_CHAR.source}|[^\\s${NO_SPACE_CHAR.source.slice(1, -1)}]+`,
  'gu',
);

/** 分词：无空格脚本逐字，其余按空白分割。 */
export function tokenize(text: string): CaptionToken[] {
  const out: CaptionToken[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    const prev = idx > 0 ? text[idx - 1] : undefined;
    out.push({ text: m[0], spaceBefore: prev !== undefined && /\s/.test(prev) });
  }
  return out;
}

/** 比较用的 token 键：小写并去掉首尾标点；纯标点 token 保留原样。 */
export function tokenKey(token: string): string {
  const stripped = token.toLowerCase().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
  return stripped || token;
}

/** 由 token 重建文本。 */
export function joinTokens(tokens: readonly CaptionToken[]): string {
  let out = '';
  for (const t of tokens) {
    if (!out) {
      out = t.text;
      continue;
    }
    // 只有原文有空白且两侧都不是无空格脚本时才补空格。
    const needSpace =
      t.spaceBefore && !isNoSpaceChar(out[out.length - 1]) && !isNoSpaceChar(t.text[0]);
    out += needSpace ? ` ${t.text}` : t.text;
  }
  return out;
}

const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'e.g',
  'i.e',
  'u.s',
  'u.k',
  'a.m',
  'p.m',
  'no',
  'vol',
  'fig',
  'inc',
  'ltd',
  'co',
  'mt',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
]);

const SENTENCE_END_RE = /[.!?。！？‼⁉](?:["'”’）)\]」』]*)$/;
/** 非句点的句末标点不涉及缩写判断。 */
const NON_PERIOD_END_RE = /[。！？‼⁉!?](?:["'”’）)\]」』]*)$/;

/** 文本（或 token）是否以句末标点结束；排除常见缩写与单字母缩写（如「J.」）。省略号不视为句末。 */
export function endsSentence(text: string): boolean {
  const t = text.trimEnd();
  if (!SENTENCE_END_RE.test(t)) return false;
  if (/(?:\.\.\.|…)["'”’）)\]」』]*$/.test(t)) return false;
  if (NON_PERIOD_END_RE.test(t)) return true;
  const lastWord = (t.split(/\s+/).pop() ?? '').replace(/["'”’）)\]」』]+$/, '');
  const bare = lastWord.replace(/\.$/, '').toLowerCase();
  if (lastWord.endsWith('.')) {
    if (ABBREVIATIONS.has(bare)) return false;
    if (/^\p{L}$/u.test(bare)) return false; // 单字母缩写 / 姓名首字母
    if (/^(?:\p{L}\.)+\p{L}$/u.test(bare)) return false; // U.S.A 之类
  }
  return true;
}

/** 以从句标点结束（逗号、分号、冒号、破折号、省略号）。 */
export function endsClause(text: string): boolean {
  return /(?:[,;:，；：、—–]|\.\.\.|…)["'”’）)\]」』]*$/.test(text.trimEnd());
}

/** FNV-1a 32 位哈希（十六进制），用于缩短过长的 id 前缀，非安全用途。 */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Cue.id 上限为 120；前缀过长时截断并附加哈希，保证稳定且不冲突。 */
export function stableIdPrefix(prefix: string, reserve = 24): string {
  const max = 120 - reserve;
  if (prefix.length <= max) return prefix;
  return `${prefix.slice(0, max - 9)}~${fnv1a(prefix)}`;
}
