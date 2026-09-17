/**
 * offscreen 文档入口（构建后 /offscreen.html）。
 * AudioWorklet 以独立文件构建（扩展 CSP 只允许同源脚本，不能使用 blob: URL）。
 */
import pcmTapWorkletUrl from '@src/audio/offscreen/pcm-tap.worklet.ts?worker&url';
import { bootstrapOffscreen } from '@src/audio/offscreen/bootstrap';

const host = bootstrapOffscreen({ workletUrl: pcmTapWorkletUrl });

// 仅供调试/自动化诊断读取（不含凭证）。
(globalThis as { __tongtingOffscreen?: unknown }).__tongtingOffscreen = {
  status: () => host.status(),
  diagnostics: () => host.diagnostics(),
};
