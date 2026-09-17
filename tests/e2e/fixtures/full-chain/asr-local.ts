/**
 * 启动真实本地识别服务（services/asr-local，faster-whisper small，离线使用已缓存模型）供 E2E 使用。
 *
 * - 令牌目录是测试运行时新建的临时目录（0700），令牌由服务生成，只保存在内存中传给扩展，不写入仓库、不打印。
 * - 服务标准输出重定向到日志文件（重定向时服务不打印令牌），日志位于 test-results/，只记录请求与耗时。
 * - 只监听 127.0.0.1:8765；启动前端口必须空闲，结束时发送 SIGINT 并等待进程退出、端口释放。
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SERVICE_DIR = resolve(import.meta.dirname, '../../../../services/asr-local');
const BIN = join(SERVICE_DIR, '.venv/bin/tongting-asr');
export const ASR_PORT = 8765;
export const ASR_BASE_URL = `http://127.0.0.1:${ASR_PORT}`;

export interface LocalAsr {
  token: string;
  logFile: string;
  health(): Promise<unknown>;
  close(): Promise<void>;
}

export async function localAsrAvailable(): Promise<string | null> {
  try {
    await access(BIN);
  } catch {
    return `缺少 ${BIN}（在 services/asr-local 运行 uv sync）`;
  }
  try {
    await access(join(SERVICE_DIR, 'models/models--Systran--faster-whisper-small'));
  } catch {
    return '本地没有缓存 small 模型（离线模式无法加载）';
  }
  return null;
}

export function portOpen(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const s = createConnection({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      resolvePort(true);
    });
    s.once('error', () => resolvePort(false));
  });
}

export async function startLocalAsr(options: {
  extensionId: string;
  logName: string;
}): Promise<LocalAsr> {
  if (await portOpen(ASR_PORT))
    throw new Error(`端口 ${ASR_PORT} 已被占用，拒绝启动（避免把令牌与音频发给其他进程）`);
  const dataDir = await mkdtemp(join(tmpdir(), 'tongting-asr-e2e-'));
  const logDir = resolve(import.meta.dirname, '../../../../test-results');
  await mkdir(logDir, { recursive: true });
  const logFile = join(logDir, `${options.logName}.asr.log`);
  const log = createWriteStream(logFile);
  const child: ChildProcess = spawn(
    BIN,
    [
      'serve',
      '--offline',
      '--port',
      String(ASR_PORT),
      '--data-dir',
      dataDir,
      '--allow-extension-id',
      options.extensionId,
      '--log-level',
      'info',
    ],
    {
      cwd: SERVICE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HF_HUB_OFFLINE: '1' },
    },
  );
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  let exited = false;
  const exitPromise = new Promise<void>((r) => child.once('exit', () => ((exited = true), r())));

  const health = async () => {
    const res = await fetch(`${ASR_BASE_URL}/health`);
    return (await res.json()) as { status: string; ready?: boolean };
  };
  const close = async () => {
    if (!exited) {
      child.kill('SIGINT');
      const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
      await exitPromise;
      clearTimeout(timer);
    }
    log.end();
    await rm(dataDir, { recursive: true, force: true });
    for (let i = 0; i < 50 && (await portOpen(ASR_PORT)); i++)
      await new Promise((r) => setTimeout(r, 100));
  };

  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (exited) throw new Error(`本地识别服务提前退出，见 ${logFile}`);
      const h = await health().catch(() => null);
      if (h?.status === 'ok') break;
      if (h?.status === 'error') throw new Error(`本地识别服务状态 error，见 ${logFile}`);
      if (Date.now() > deadline) throw new Error(`本地识别服务 60 s 内未就绪，见 ${logFile}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    const { stdout } = await run(BIN, ['print-token', '--data-dir', dataDir], { cwd: SERVICE_DIR });
    const token = stdout.trim().split(/\s+/).pop() ?? '';
    if (!/^[A-Za-z0-9_-]{32,}$/.test(token))
      throw new Error('无法读取本地识别服务令牌（输出格式不符）');
    return { token, logFile, health, close };
  } catch (error) {
    await close();
    throw error;
  }
}
