/**
 * 增量 SSE（text/event-stream）解析器。
 *
 * - 以「行」为单位累积，跨网络 chunk 保持状态；不会对单个网络 chunk 调用 JSON.parse。
 * - 支持 LF / CRLF / CR 行结束（包括 CR 与 LF 被拆到两个 chunk 的情况）。
 * - 多行 data 以 `\n` 拼接；`:` 开头为注释；支持 event / id 字段；忽略 retry 与未知字段。
 * - 字节 → 文本使用流式 TextDecoder，正确处理被拆开的 UTF-8 多字节字符。
 */
import { AppError } from '../../domain/errors';
import { streamInterruptedError } from './http-errors';

export interface SseEvent {
  /** 事件类型；未指定时为 'message'。 */
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = '';
  private pendingCr = false;
  private dataLines: string[] = [];
  private eventType = '';
  private lastEventId: string | undefined;
  private hasData = false;

  /** 输入一段文本，返回其中已完整结束（遇到空行）的事件。 */
  push(chunk: string): SseEvent[] {
    const events: SseEvent[] = [];
    let text = chunk;
    if (text.length === 0) return events;
    if (this.pendingCr) {
      // 上一个 chunk 以 CR 结尾：若本 chunk 以 LF 开头，它属于同一个 CRLF。
      this.pendingCr = false;
      if (text.startsWith('\n')) text = text.slice(1);
    }
    this.buffer += text;

    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer.charCodeAt(i);
      if (ch !== 10 && ch !== 13) continue;
      const line = this.buffer.slice(start, i);
      if (ch === 13) {
        if (i + 1 < this.buffer.length) {
          if (this.buffer.charCodeAt(i + 1) === 10) i++;
        } else {
          this.pendingCr = true;
        }
      }
      start = i + 1;
      const event = this.processLine(line);
      if (event) events.push(event);
    }
    this.buffer = this.buffer.slice(start);
    return events;
  }

  /**
   * 流结束：处理最后一行（无换行结尾）并返回尚未以空行结束的事件。
   * 调用方仍须依据协议的结束事件判断响应是否完整。
   */
  finish(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length > 0) {
      const event = this.processLine(this.buffer);
      if (event) events.push(event);
      this.buffer = '';
    }
    const tail = this.dispatch();
    if (tail) events.push(tail);
    this.pendingCr = false;
    return events;
  }

  private processLine(line: string): SseEvent | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    switch (field) {
      case 'data':
        this.dataLines.push(value);
        this.hasData = true;
        break;
      case 'event':
        this.eventType = value;
        break;
      case 'id':
        if (!value.includes('\u0000')) this.lastEventId = value;
        break;
      default:
        // retry 与未知字段忽略
        break;
    }
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    if (!this.hasData) {
      this.eventType = '';
      return undefined;
    }
    const event: SseEvent = {
      event: this.eventType || 'message',
      data: this.dataLines.join('\n'),
    };
    if (this.lastEventId !== undefined) event.id = this.lastEventId;
    this.dataLines = [];
    this.eventType = '';
    this.hasData = false;
    return event;
  }
}

export interface ReadSseOptions {
  signal: AbortSignal;
  /** 返回 'stop' 表示已收到协议结束事件，可停止读取。 */
  onEvent: (event: SseEvent) => void | 'stop';
  maxBytes?: number;
}

/**
 * 读取 SSE 字节流直到结束、onEvent 返回 'stop'、或 signal 中止。
 * 返回值表示是否由 onEvent 主动停止（即收到了结束事件）。
 *
 * - 任何异常退出（onEvent 抛错、超出大小、中止）都会 await reader.cancel()，让底层连接关闭，
 *   服务端不再继续生成。
 * - 流结束时没有以空行结束的最后一个事件视为可能被截断：若它无法解析，映射为可重试的 stream-interrupted。
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  options: ReadSseOptions,
): Promise<{ stopped: boolean; bytes: number }> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = new SseParser();
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  let bytes = 0;
  let cancelled = false;
  const cancel = async () => {
    if (cancelled) return;
    cancelled = true;
    try {
      await reader.cancel();
    } catch {
      // 已出错或已关闭的流无法取消，忽略
    }
  };
  const onAbort = () => {
    void cancel();
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (options.signal.aborted) throw new DOMException('aborted', 'AbortError');
    for (;;) {
      const { done, value } = await reader.read();
      if (options.signal.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      if (done) {
        for (const event of parser.push(decoder.decode())) {
          if (options.onEvent(event) === 'stop') return { stopped: true, bytes };
        }
        for (const event of parser.finish()) {
          let result: void | 'stop';
          try {
            result = options.onEvent(event);
          } catch (error) {
            if (error instanceof AppError && error.info.code === 'invalid-stream-event') {
              throw streamInterruptedError('truncated event at EOF');
            }
            throw error;
          }
          if (result === 'stop') return { stopped: true, bytes };
        }
        return { stopped: false, bytes };
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new AppError({
          code: 'response-too-large',
          category: 'format',
          retryable: false,
          message: '服务返回的流式内容过大，已停止读取。',
        });
      }
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        if (options.onEvent(event) === 'stop') {
          await cancel();
          return { stopped: true, bytes };
        }
      }
    }
  } catch (error) {
    await cancel();
    throw error;
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // 已取消的 reader 可能无法释放锁，忽略
    }
  }
}
