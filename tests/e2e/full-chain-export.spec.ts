/**
 * 全链路 E2E（T35 导出）：字幕轨道 → mock 翻译（开启全片补译）→ IndexedDB 记录 → 扩展工作台（workspace.html）
 * 收藏两条 → 导出对话框真实点击下载 SRT / VTT / TXT（原文、译文、双语、仅收藏）。
 *
 * 校验方式：
 * 1. 自写严格解析器（本文件 parseSrt / parseVtt / parseTxt）：编号连续、时间格式与单调性、空行分隔、文本行非空、无 `-->`、无 \r；
 * 2. ffprobe（/opt/homebrew/bin/ffprobe）读取 SRT/VTT 字幕流的包数量与时间，ffmpeg 把 SRT 重新输出为 SRT 以核对文本；
 * 3. 与 UI 端口中的会话字幕（worker 下发的 cues）逐条比对范围、顺序与语言；文件名按产品规则核对。
 *
 * 前置：TONGTING_E2E=1 pnpm exec wxt build；ffmpeg/ffprobe 可用。
 */
import { expect, test, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  configureProvider,
  openWatch,
  setupFullChain,
  video,
  type FullChain,
} from './helpers/full-chain';
import { mockTranslation } from './fixtures/full-chain/mock-sub2api';
import { FFMPEG, FFPROBE } from './fixtures/audio/speech';
import { ffmpegAvailable, silentVideo } from './fixtures/full-chain/media';
import type { CaptionLine } from './fixtures/full-chain/youtube';
import type { Cue } from '../../src/domain/cue';

test.describe.configure({ timeout: 240_000 });
const run = promisify(execFile);

const VIDEO_A = 'AAAAAAAAAAA';
const TITLE = 'Export: <Test> "Video" / 中文?';
const OUT_DIR = resolve(import.meta.dirname, '../../test-results/export-downloads');
const LINES: CaptionLine[] = [
  { startMs: 1_000, durationMs: 2_500, text: 'Plain first line.' },
  { startMs: 4_000, durationMs: 2_500, text: 'Tags <i>italic</i> & "quotes" here.' },
  { startMs: 7_000, durationMs: 2_500, text: 'Arrow --> inside the text.' },
  { startMs: 10_000, durationMs: 2_500, text: 'Emoji 😀 and CJK 中文 mixed.' },
  { startMs: 13_000, durationMs: 2_500, text: 'Numbers like 3.5 stay.' },
  { startMs: 61_000, durationMs: 2_500, text: 'Far away line needs backfill.' },
  { startMs: 3_600_500, durationMs: 1_500, text: 'Past one hour line.' },
];

let fc: FullChain | undefined;
test.afterEach(async () => {
  await fc?.close();
  fc = undefined;
});

interface Entry {
  index?: number;
  startMs: number;
  endMs: number;
  lines: string[];
}

function ts(h: string, m: string, s: string, ms: string): number {
  expect(Number(m)).toBeLessThan(60);
  expect(Number(s)).toBeLessThan(60);
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
}

function checkCommon(text: string) {
  expect(text.includes('\r'), '只用 LF 换行').toBe(false);
  expect(text.startsWith('﻿'), '默认不带 BOM').toBe(false);
  expect(text.endsWith('\n')).toBe(true);
}

/** 严格 SRT：`n\nHH:MM:SS,mmm --> HH:MM:SS,mmm\ntext+`，块间恰好一个空行，编号从 1 连续。 */
function parseSrt(text: string): Entry[] {
  checkCommon(text);
  const body = text.slice(0, -1);
  if (!body) return [];
  expect(body.includes('\n\n\n')).toBe(false);
  return body.split('\n\n').map((block, i) => {
    const [idx, timing, ...lines] = block.split('\n');
    expect(idx, `第 ${i + 1} 块编号`).toBe(String(i + 1));
    const m = /^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(
      timing ?? '',
    );
    expect(m, `第 ${i + 1} 块时间行：${timing}`).not.toBeNull();
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.trim().length, '文本行非空').toBeGreaterThan(0);
      expect(l.includes('-->')).toBe(false);
    }
    return {
      index: i + 1,
      startMs: ts(m![1]!, m![2]!, m![3]!, m![4]!),
      endMs: ts(m![5]!, m![6]!, m![7]!, m![8]!),
      lines,
    };
  });
}

/** 严格 WebVTT：首行 WEBVTT，NOTE 块不含 `-->`，cue 时间 `HH:MM:SS.mmm`，文本中 & < > 已转义。 */
function parseVtt(text: string): { note: string[]; entries: Entry[] } {
  checkCommon(text);
  const blocks = text.slice(0, -1).split('\n\n');
  expect(blocks[0]).toBe('WEBVTT');
  const note: string[] = [];
  const entries: Entry[] = [];
  for (const block of blocks.slice(1)) {
    const lines = block.split('\n');
    if (lines[0]!.startsWith('NOTE')) {
      expect(block.includes('-->')).toBe(false);
      note.push(...lines);
      continue;
    }
    const m = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(
      lines[0]!,
    );
    expect(m, `VTT 时间行：${lines[0]}`).not.toBeNull();
    const textLines = lines.slice(1);
    expect(textLines.length).toBeGreaterThan(0);
    for (const l of textLines) {
      expect(l.trim().length).toBeGreaterThan(0);
      expect(l.includes('-->')).toBe(false);
      expect(/<|&(?!amp;|lt;|gt;)/.test(l), `VTT 文本已转义：${l}`).toBe(false);
    }
    entries.push({
      startMs: ts(m![1]!, m![2]!, m![3]!, m![4]!),
      endMs: ts(m![5]!, m![6]!, m![7]!, m![8]!),
      lines: textLines,
    });
  }
  return { note, entries };
}

function parseTxt(text: string): {
  header: string[];
  entries: Array<{ startMs: number; lines: string[] }>;
} {
  checkCommon(text);
  const [head, ...rest] = text.slice(0, -1).split('\n\n');
  const entries = rest.map((block) => {
    const m = /^\[(\d{2}):(\d{2}):(\d{2})\] (.*)$/s.exec(block);
    expect(m, `TXT 条目：${block}`).not.toBeNull();
    return { startMs: ts(m![1]!, m![2]!, m![3]!, '0'), lines: m![4]!.split('\n') };
  });
  return { header: head!.split('\n'), entries };
}

const unescapeVtt = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function ffprobePackets(file: string): Promise<Array<{ startMs: number; endMs: number }>> {
  const { stdout } = await run(FFPROBE, [
    '-v',
    'error',
    '-of',
    'json',
    '-show_packets',
    '-show_streams',
    file,
  ]);
  const data = JSON.parse(stdout) as {
    streams: Array<{ codec_type: string; codec_name: string }>;
    packets: Array<{ pts_time: string; duration_time: string }>;
  };
  expect(data.streams.map((s) => s.codec_type)).toEqual(['subtitle']);
  return data.packets.map((p) => ({
    startMs: Math.round(Number(p.pts_time) * 1000),
    endMs: Math.round((Number(p.pts_time) + Number(p.duration_time)) * 1000),
  }));
}

async function selectSegment(page: Page, group: string, option: RegExp) {
  await page.getByRole('group', { name: group }).getByRole('button', { name: option }).click();
  await expect(
    page.getByRole('group', { name: group }).getByRole('button', { name: option }),
  ).toHaveAttribute('aria-pressed', 'true');
}

test('T35 工作台真实下载 SRT/VTT/TXT：原文、译文、双语、仅收藏，严格解析 + ffprobe 校验', async () => {
  test.skip(!(await ffmpegAvailable()), '需要 ffmpeg/ffprobe');
  fc = await setupFullChain({
    videos: [
      {
        videoId: VIDEO_A,
        title: TITLE,
        lengthSeconds: 3_605,
        captions: LINES,
        media: await silentVideo(90),
      },
    ],
  });
  const f = fc;
  await configureProvider(f);
  const { page, tabId } = await openWatch(f, VIDEO_A);
  await f.ui.ok({ kind: 'session/start', tabId });
  const s = await f.ui.waitSession(tabId, (x) => x.phase === 'running' && !!x.recordId, {
    timeout: 30_000,
  });
  await f.ui.ok({
    kind: 'session/backfill',
    tabId,
    sessionId: s.identity.sessionId,
    enabled: true,
  });
  await f.ui.waitSession(
    tabId,
    (x) => x.translation.total > 0 && x.translation.done === x.translation.total,
    {
      timeout: 60_000,
      message: '全片补译完成',
    },
  );
  await f.ui.subscribeCues(s.identity.sessionId);
  await expect.poll(async () => (await f.ui.cues(s.identity.sessionId)).length).toBeGreaterThan(0);
  const cues: Cue[] = await f.ui.cues(s.identity.sessionId);
  expect(cues.every((c) => c.translationState === 'done')).toBe(true);
  await video(page).pause();

  // 工作台：在左侧点选该视频的记录（实时会话条目不会自动选中），收藏第 2、4 条。
  const ws = await f.ext.context.newPage();
  const wsLogs: string[] = [];
  ws.on('console', (m) => wsLogs.push(`${m.type()}: ${m.text().slice(0, 200)}`));
  ws.on('pageerror', (e) => wsLogs.push(`pageerror: ${e.message.slice(0, 300)}`));
  await ws.goto(`chrome-extension://${f.ext.extensionId}/workspace.html`);
  await ws
    .getByRole('region', { name: '字幕记录' })
    .or(ws.getByLabel('字幕记录'))
    .getByText(TITLE)
    .first()
    .click();
  const ready = await ws
    .getByRole('button', { name: /^收藏 .* 字幕$/ })
    .first()
    .waitFor({ timeout: 20_000 })
    .then(
      () => true,
      () => false,
    );
  if (!ready) {
    console.log('[T35 workspace body]', (await ws.locator('body').innerText()).slice(0, 1500));
    console.log('[T35 workspace logs]', wsLogs.join('\n').slice(0, 2000));
    console.log('[T35 workspace html]', (await ws.content()).slice(0, 1500));
  }
  expect(ready, '工作台显示字幕列表与收藏按钮').toBe(true);
  const favTargets = [cues[1]!, cues[3]!];
  for (const c of favTargets) {
    const row = ws.locator(`[role="listitem"][data-cue-id="${c.id}"]`);
    await row.getByRole('button', { name: /^收藏 .* 字幕$/ }).click();
    await expect(row.getByRole('button', { name: /^取消收藏 .* 字幕$/ })).toBeVisible();
  }
  await expect(ws.getByText('2 条收藏')).toBeVisible({ timeout: 10_000 });

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  const results: Array<Record<string, unknown>> = [];
  const combos = (['srt', 'vtt', 'txt'] as const).flatMap((format) =>
    (
      [
        { scope: 'all', content: 'original' },
        { scope: 'all', content: 'translation' },
        { scope: 'all', content: 'bilingual' },
        { scope: 'favorites', content: 'bilingual' },
      ] as const
    ).map((c) => ({ format, ...c })),
  );

  for (const combo of combos) {
    await ws.getByRole('button', { name: '导出字幕' }).click();
    const dialog = ws.getByRole('dialog', { name: '导出字幕' });
    await expect(dialog).toBeVisible();
    await selectSegment(ws, '导出格式', new RegExp(`^${combo.format.toUpperCase()}$`));
    await dialog.getByLabel('范围').selectOption(combo.scope);
    await dialog.getByLabel('内容', { exact: true }).selectOption(combo.content);
    await expect(dialog.getByLabel('范围')).toHaveValue(combo.scope);
    if (combo.scope === 'favorites') {
      await expect(dialog.getByLabel('范围').locator('option[value="favorites"]')).toHaveText(
        '仅收藏（2 条）',
      );
    }
    const [download] = await Promise.all([
      ws.waitForEvent('download'),
      dialog.getByRole('button', { name: `下载 ${combo.format.toUpperCase()}` }).click(),
    ]);
    const filename = download.suggestedFilename();
    const file = join(OUT_DIR, `${combo.format}-${combo.scope}-${combo.content}.${combo.format}`);
    await download.saveAs(file);
    const text = await readFile(file, 'utf8');
    if (await dialog.isVisible()) await dialog.getByRole('button', { name: '取消' }).click();

    const selected = combo.scope === 'favorites' ? favTargets : cues;
    // 产品在所有导出格式中把文本内的 `-->` 替换为 `→`（SRT/VTT 中否则会被解析为时间行）。
    const arrow = (t: string) => t.replace(/-{2,}>/g, '→');
    const expectedLines = (c: Cue) =>
      (combo.content === 'original'
        ? [c.sourceText]
        : combo.content === 'translation'
          ? [c.translatedText!]
          : [c.translatedText!, c.sourceText]
      ).map(arrow);
    const lang = combo.content === 'original' ? 'en' : 'zh-CN';
    const tags = [
      combo.scope === 'favorites' ? '收藏' : null,
      combo.content === 'bilingual' ? '双语' : null,
    ].filter(Boolean);
    expect(filename).toBe(['Export Test Video 中文', ...tags, lang, combo.format].join('.'));

    const record: Record<string, unknown> = { ...combo, filename, bytes: Buffer.byteLength(text) };
    if (combo.format === 'srt') {
      const entries = parseSrt(text);
      expect(entries.map((e) => e.startMs)).toEqual(selected.map((c) => c.startMs));
      expect(entries.map((e) => e.endMs)).toEqual(selected.map((c) => c.endMs));
      expect(entries.map((e) => e.lines.join('\n'))).toEqual(
        selected.map((c) => expectedLines(c).join('\n')),
      );
      const packets = await ffprobePackets(file);
      expect(packets).toEqual(entries.map((e) => ({ startMs: e.startMs, endMs: e.endMs })));
      const { stdout } = await run(FFMPEG, ['-v', 'error', '-i', file, '-f', 'srt', '-']);
      for (const c of selected) for (const l of expectedLines(c)) expect(stdout).toContain(l);
      record.ffprobePackets = packets.length;
    } else if (combo.format === 'vtt') {
      const { note, entries } = parseVtt(text);
      expect(note[0]).toBe('NOTE 译听 Vocasub 导出');
      expect(entries.map((e) => [e.startMs, e.endMs])).toEqual(
        selected.map((c) => [c.startMs, c.endMs]),
      );
      expect(entries.map((e) => e.lines.map(unescapeVtt).join('\n'))).toEqual(
        selected.map((c) => expectedLines(c).join('\n')),
      );
      const packets = await ffprobePackets(file);
      expect(packets).toEqual(entries.map((e) => ({ startMs: e.startMs, endMs: e.endMs })));
      record.ffprobePackets = packets.length;
      record.note = note;
    } else {
      const { header, entries } = parseTxt(text);
      expect(header[0]).toBe('译听 Vocasub 字幕导出');
      expect(header).toContain(`视频 ID：${VIDEO_A}`);
      expect(entries.map((e) => Math.floor(e.startMs / 1000))).toEqual(
        selected.map((c) => Math.floor(c.startMs / 1000)),
      );
      expect(entries.map((e) => e.lines.join('\n'))).toEqual(
        selected.map((c) => expectedLines(c).join('\n')),
      );
      record.header = header;
    }
    results.push(record);
  }
  // 特殊字符实际输出（供记录）。
  const srtBi = await readFile(join(OUT_DIR, 'srt-all-bilingual.srt'), 'utf8');
  const vttBi = await readFile(join(OUT_DIR, 'vtt-all-bilingual.vtt'), 'utf8');
  test.info().annotations.push({
    type: 'evidence',
    description: JSON.stringify({
      cues: cues.map((c) => ({
        startMs: c.startMs,
        endMs: c.endMs,
        source: c.sourceText,
        translated: c.translatedText,
      })),
      results,
      srtSample: srtBi.split('\n\n').slice(1, 4),
      vttSample: vttBi.split('\n\n').slice(2, 5),
      expectedMock: mockTranslation('zh-CN', LINES[0]!.text),
    }),
  });
  console.log(
    '[T35]',
    JSON.stringify({ n: results.length, files: results.map((r) => r.filename) }),
  );
});
