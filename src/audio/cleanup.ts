/**
 * 资源释放工具（T26）。
 *
 * - 每个资源一个独立释放入口，按登记的逆序释放。
 * - 单个释放入口抛错（同步或异步）不阻止其余入口执行。
 * - 可重复调用：已释放的入口不会再次执行。
 */

export type Disposer = () => void | Promise<void>;

export interface ReleaseFailure {
  name: string;
  error: unknown;
}

export interface ReleaseReport {
  released: string[];
  failed: ReleaseFailure[];
}

/** 依次执行释放函数；任何一个失败都继续执行后续项。 */
export async function releaseAll(
  entries: ReadonlyArray<readonly [string, Disposer | null | undefined]>,
): Promise<ReleaseReport> {
  const report: ReleaseReport = { released: [], failed: [] };
  for (const [name, dispose] of entries) {
    if (!dispose) continue;
    try {
      await dispose();
      report.released.push(name);
    } catch (error) {
      report.failed.push({ name, error });
    }
  }
  return report;
}

/** 同步版本：用于必须立即生效的释放（例如停止 tracks），异步返回值被忽略但错误会被吞掉并记录。 */
export function releaseAllSync(
  entries: ReadonlyArray<readonly [string, (() => void) | null | undefined]>,
): ReleaseReport {
  const report: ReleaseReport = { released: [], failed: [] };
  for (const [name, dispose] of entries) {
    if (!dispose) continue;
    try {
      dispose();
      report.released.push(name);
    } catch (error) {
      report.failed.push({ name, error });
    }
  }
  return report;
}

/**
 * 资源袋：登记释放函数，统一释放。登记返回的函数可单独释放该资源（只执行一次）。
 */
export class ResourceBag {
  private entries: { name: string; dispose: Disposer; done: boolean }[] = [];

  add(name: string, dispose: Disposer): () => Promise<void> {
    const entry = { name, dispose, done: false };
    this.entries.push(entry);
    return async () => {
      if (entry.done) return;
      entry.done = true;
      this.entries = this.entries.filter((e) => e !== entry);
      await entry.dispose();
    };
  }

  get size(): number {
    return this.entries.length;
  }

  names(): string[] {
    return this.entries.map((e) => e.name);
  }

  /** 逆序释放全部资源；可重复调用。 */
  async releaseAll(): Promise<ReleaseReport> {
    const pending = this.entries.slice().reverse();
    this.entries = [];
    const report: ReleaseReport = { released: [], failed: [] };
    for (const entry of pending) {
      if (entry.done) continue;
      entry.done = true;
      try {
        await entry.dispose();
        report.released.push(entry.name);
      } catch (error) {
        report.failed.push({ name: entry.name, error });
      }
    }
    return report;
  }
}

/** 停止 MediaStream 的全部 tracks；返回实际调用 stop 的数量。单个 track 抛错不影响其他。 */
export function stopAllTracks(stream: Pick<MediaStream, 'getTracks'> | null | undefined): number {
  if (!stream) return 0;
  let stopped = 0;
  let tracks: MediaStreamTrack[];
  try {
    tracks = stream.getTracks();
  } catch {
    return 0;
  }
  for (const track of tracks) {
    try {
      track.stop();
      stopped++;
    } catch {
      // 继续停止其余 track
    }
  }
  return stopped;
}
