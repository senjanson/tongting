/**
 * 覆盖层 Shadow DOM 样式。只作用于 shadow root 内部，不影响 YouTube 页面样式。
 * 配色取自 A 轻巧侧栏原型的深松绿字幕底色。
 */
export const OVERLAY_CSS = `
:host {
  all: initial;
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 40;
  contain: layout style;
  --tt-font-size: 22px;
  --tt-bg-opacity: 0.75;
  --tt-bottom: 64px;
}
:host([hidden]) { display: none !important; }
.stage {
  position: absolute;
  inset: 0;
  pointer-events: none;
  font-family: system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  color: #fff;
}
.badge {
  position: absolute;
  top: 12px;
  left: 12px;
  max-width: 60%;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.4;
  color: #dff3ec;
  background: rgba(16, 35, 31, 0.78);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.caption {
  position: absolute;
  left: 5%;
  right: 5%;
  bottom: var(--tt-bottom);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  text-align: center;
  transition: bottom 0.18s ease;
}
.caption[data-position="top"] { top: 8%; bottom: auto; }
.caption[data-position="middle"] { top: 50%; bottom: auto; transform: translateY(-50%); }
.line {
  max-width: 100%;
  padding: 2px 10px;
  border-radius: 5px;
  background: rgba(16, 35, 31, var(--tt-bg-opacity));
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.5;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
}
.main { font-size: var(--tt-font-size); font-weight: 500; }
.main[data-pending] { opacity: 0.86; }
.main[data-interim] { opacity: 0.78; }
.secondary { font-size: calc(var(--tt-font-size) * 0.64); color: #f1f2ec; }
[hidden] { display: none !important; }
`;
