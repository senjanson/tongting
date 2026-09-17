/**
 * 在可信扩展页面中触发本地下载（Blob + a[download]），不使用 downloads 权限。
 */
import { EXPORT_MIME, type ExportFormat } from './format';

/** 下载后延迟释放对象 URL，避免浏览器尚未读取 Blob 就被回收。 */
const REVOKE_DELAY_MS = 30_000;

/** UTF-8 BOM：部分 Windows 播放器需要它才能正确识别中文字幕编码。 */
export const UTF8_BOM = '\uFEFF';

export interface DownloadOptions {
  /** 是否在文件开头写入 UTF-8 BOM，默认否。 */
  bom?: boolean;
  doc?: Document;
}

/** 生成实际写入文件的文本（按需加 BOM）。 */
export function withOptionalBom(text: string, bom: boolean | undefined): string {
  return bom && !text.startsWith(UTF8_BOM) ? `${UTF8_BOM}${text}` : text;
}

export function downloadTextFile(
  text: string,
  filename: string,
  mime: string,
  options: DownloadOptions = {},
): void {
  const doc = options.doc ?? document;
  const blob = new Blob([withOptionalBom(text, options.bom)], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  doc.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}

export function downloadExport(
  format: ExportFormat,
  text: string,
  filename: string,
  options: DownloadOptions = {},
): void {
  downloadTextFile(text, filename, EXPORT_MIME[format], options);
}
