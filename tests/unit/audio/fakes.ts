/**
 * 单测用的 Web Audio / MediaStream 替身：记录副作用（tracks 停止、节点连接、上下文关闭），
 * 以便用可观察证据验证资源释放，而不是只比较状态字段。
 */
import { vi } from 'vitest';

export class FakeTrack {
  readyState: 'live' | 'ended' = 'live';
  readonly kind = 'audio';
  private listeners = new Set<() => void>();
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
  addEventListener(type: string, fn: () => void) {
    if (type === 'ended') this.listeners.add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    if (type === 'ended') this.listeners.delete(fn);
  }
  get listenerCount() {
    return this.listeners.size;
  }
  /** 模拟标签页关闭/权限撤回：浏览器结束 track（不会调用 stop）。 */
  fireEnded() {
    this.readyState = 'ended';
    for (const fn of Array.from(this.listeners)) fn();
  }
}

export class FakeStream {
  constructor(readonly tracks: FakeTrack[] = [new FakeTrack()]) {}
  getTracks() {
    return this.tracks as unknown as MediaStreamTrack[];
  }
  getAudioTracks() {
    return this.tracks as unknown as MediaStreamTrack[];
  }
}

export class FakeParam {
  constructor(public value: number) {}
  cancelScheduledValues = vi.fn();
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
}

export class FakeNode {
  readonly connections: unknown[] = [];
  connect = vi.fn((target: unknown) => {
    this.connections.push(target);
    return target;
  });
  disconnect = vi.fn(() => {
    this.connections.length = 0;
  });
}

export class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}

export class FakeWorkletNode extends FakeNode {
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: vi.fn(),
    close: vi.fn(),
  };
  constructor(
    readonly name: string,
    readonly options: unknown,
  ) {
    super();
  }
  deliver(data: unknown) {
    this.port.onmessage?.({ data });
  }
}

export class FakeAudioContext {
  state: 'running' | 'suspended' | 'closed' = 'running';
  currentTime = 0;
  baseLatency = 0.01;
  outputLatency = 0.02;
  readonly destination = new FakeNode();
  readonly sources: FakeNode[] = [];
  readonly gains: FakeGain[] = [];
  readonly buffers: unknown[] = [];
  addModuleImpl: (url: string) => Promise<void> = async () => undefined;
  audioWorklet = { addModule: vi.fn((url: string) => this.addModuleImpl(url)) };
  closeImpl: () => Promise<void> = async () => undefined;
  close = vi.fn(async () => {
    await this.closeImpl();
    this.state = 'closed';
  });
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  private stateListeners = new Set<() => void>();
  addEventListener = vi.fn((type: string, fn: () => void) => {
    if (type === 'statechange') this.stateListeners.add(fn);
  });
  removeEventListener = vi.fn((type: string, fn: () => void) => {
    if (type === 'statechange') this.stateListeners.delete(fn);
  });
  /** 模拟系统/浏览器改变上下文状态。 */
  fireStateChange(state: 'running' | 'suspended' | 'closed') {
    this.state = state;
    for (const fn of Array.from(this.stateListeners)) fn();
  }
  get stateListenerCount() {
    return this.stateListeners.size;
  }
  constructor(
    readonly sampleRate = 48000,
    /** performance.now() = contextTime × 1000 + perfOffset */
    readonly perfOffset = 1000,
  ) {}
  getOutputTimestamp() {
    return {
      contextTime: this.currentTime,
      performanceTime: this.currentTime * 1000 + this.perfOffset,
    };
  }
  createMediaStreamSource = vi.fn(() => {
    const n = new FakeNode();
    this.sources.push(n);
    return n;
  });
  createGain = vi.fn(() => {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  });
  createBufferSource = vi.fn(() => new FakeBufferSource());
  decodeImpl: (data: ArrayBuffer) => Promise<unknown> = async () => ({ duration: 1 });
  decodeAudioData = vi.fn((data: ArrayBuffer) => this.decodeImpl(data));
}

export class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  start = vi.fn(() => {
    this.started = true;
  });
  stop = vi.fn(() => {
    this.stopped = true;
  });
  finish() {
    this.onended?.();
  }
}

export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function tone(ms: number, sampleRate: number, amp = 0.3, freq = 220): Float32Array {
  const n = Math.round((ms / 1000) * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}
