/**
 * 构建 P0 音频实验扩展。
 *
 * - root 为临时目录：WXT 会在 root 下生成 .wxt 类型文件，避免改写项目根目录的生成类型。
 * - 临时入口只做转发：background → 本目录 worker.ts；offscreen → 产品的 entrypoints/offscreen/main.ts（同一 worklet 与 bootstrap）。
 * - 被引用的源码位于项目内，依赖从项目 node_modules 解析。
 */
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'wxt';

export const PROJECT_ROOT = resolve(import.meta.dirname, '../../../../..');

export async function buildAudioHarness(workDir: string): Promise<string> {
  await rm(workDir, { recursive: true, force: true });
  const entry = join(workDir, 'entrypoints');
  await mkdir(join(entry, 'offscreen'), { recursive: true });
  await writeFile(
    join(workDir, 'package.json'),
    JSON.stringify({ name: 'tongting-audio-p0', version: '0.0.1', private: true, type: 'module' }),
  );
  await writeFile(
    join(entry, 'background.ts'),
    `export { default } from ${JSON.stringify(join(import.meta.dirname, 'worker.ts'))};\n`,
  );
  await copyFile(
    join(PROJECT_ROOT, 'entrypoints/offscreen/index.html'),
    join(entry, 'offscreen/index.html'),
  );
  await writeFile(
    join(entry, 'offscreen/main.ts'),
    `import ${JSON.stringify(join(PROJECT_ROOT, 'entrypoints/offscreen/main.ts'))};\n`,
  );
  await build({
    root: workDir,
    configFile: false,
    imports: false,
    alias: { '@src': join(PROJECT_ROOT, 'src') },
    manifest: {
      name: 'Tongting audio P0 harness',
      minimum_chrome_version: '116',
      permissions: ['tabCapture', 'offscreen', 'tts'],
      // 模拟用户已授予产品 manifest 中的可选主机权限（本地识别服务不返回 CORS 头，只能依靠主机权限访问）。
      host_permissions: ['http://127.0.0.1/*'],
    },
  });
  return join(workDir, '.output', 'chrome-mv3');
}
