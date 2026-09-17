/**
 * 语音识别契约。识别请求在 offscreen 发起（音频数据不经 runtime 消息传输）。
 *
 * 本地识别服务 HTTP 契约（services/asr-local 实现，扩展端客户端必须一致）：
 *
 *   GET  /health
 *        无需令牌，只返回非敏感状态：
 *        { "status": "ok" | "loading" | "error", "ready": bool, "model": str, "device": str,
 *          "computeType": str, "version": str }
 *
 *   POST /v1/transcribe?language=<code|auto>
 *        Headers: Authorization: Bearer <配对令牌>, Content-Type: audio/wav
 *        Body: 16 kHz、单声道、16-bit PCM WAV，最长 30 秒（服务端限制请求体 ≤ 2 MB）
 *        200: { "text": str, "language": str, "languageProbability": float, "durationMs": int,
 *               "processingMs": int,
 *               "segments": [{ "startMs": int, "endMs": int, "text": str,
 *                              "avgLogprob": float, "noSpeechProb": float }] }
 *        400 invalid_language / unsupported_language / invalid_request（不可重试）；401 令牌错误；
 *        403 Origin 不允许 / host_not_allowed（Host 头不是 127.0.0.1:<port>）/ 跨站 no-cors 探测；
 *        404 / 405；408 request_timeout（请求体未在 15 秒内收完，连接关闭，可重试）；
 *        413 音频过长或请求体过大；415 格式错误；429 繁忙（含 Retry-After）；
 *        499 排队中客户端断开（客户端通常收不到）；500 transcription_failed / internal_error；
 *        503 model_loading（含 Retry-After: 5）/ model_unavailable。
 *        所有错误体：{ "error": { "code": str, "message": str } }
 *
 * 服务仅绑定 127.0.0.1（IPv4），不设置 CORS 头；扩展只能以 http://127.0.0.1:<port> 访问并依赖主机权限，
 * 不使用 localhost（可能解析到被其他进程占用的 ::1）。拒绝带有非 chrome-extension:// Origin 的请求。
 */
import type { AppErrorInfo } from '../../domain/errors';

export interface AsrSegmentResult {
  startMs: number;
  endMs: number;
  text: string;
  avgLogprob?: number;
  noSpeechProb?: number;
}

export interface AsrTranscription {
  text: string;
  language?: string;
  languageProbability?: number;
  durationMs: number;
  processingMs?: number;
  segments: AsrSegmentResult[];
}

export interface AsrHealth {
  status: 'ok' | 'loading' | 'error' | 'unreachable';
  ready: boolean;
  model?: string;
  device?: string;
  computeType?: string;
  version?: string;
  error?: AppErrorInfo;
}

export interface AsrProvider {
  readonly kind: 'local' | 'sub2api' | 'mock';
  transcribe(
    wav: ArrayBuffer,
    options: { language: string; signal: AbortSignal; timeoutMs: number },
  ): Promise<AsrTranscription>;
  health(signal: AbortSignal): Promise<AsrHealth>;
}
