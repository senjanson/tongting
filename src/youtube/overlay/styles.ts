/**
 * 覆盖层 Shadow DOM 样式。只作用于 shadow root 内部，不影响 YouTube 页面样式。
 *
 * 四套外观由 .stage[data-theme] 切换（auto 在脚本中解析为 paper），数值取自多主题字幕层设计稿：
 * - paper 纸墨：半透明深色底板承托两行，主行白色衬线体，原文浅灰；浅色状态标签。
 * - ink 夜墨：更深的底板，主行近白衬线体，原文薄荷绿；深色状态标签配薄荷标记。
 * - cinema 影院：无底板，主行黄色粗体、原文白色，靠强文字阴影保证可读；标记为黄色。
 * - wave 声浪：主行在白色圆角卡片上（深色粗体），原文在蓝色胶囊上（白字）；蓝色状态标签。
 *
 * 只使用系统字体（页面内不加载网络字体，也不声明 web_accessible_resources）。
 * 字号（--tt-font-size）决定两行字号与底板/卡片的内边距和圆角；背景不透明度（--tt-bg-opacity）：
 * - paper/ink：直接作为底板透明度（ink 按设计稿比例略深，超过 1 时按 1 处理）；
 * - wave：卡片上的深色文字依赖卡片本身，透明度按 0.8 + 0.2 × 设置值映射，滑块仍有作用但卡片不会透明到看不清；
 * - cinema：没有底板，不受该设置影响。
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
  --tt-sans: system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  --tt-serif: "Noto Serif SC", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "STSong", serif;
  /* paper（默认，auto 同此） */
  --badge-bg: rgba(244, 241, 234, 0.94);
  --badge-fg: #1b1d1a;
  --badge-muted: #5b6058;
  --mark-bg: #1f6b52;
  --mark-fg: #f4f1ea;
  --plate-bg: rgba(16, 17, 16, var(--tt-bg-opacity));
  --plate-pad: calc(var(--tt-font-size) * 0.4) calc(var(--tt-font-size) * 0.85);
  --gap: 4px;
  --main-font: var(--tt-serif);
  --main-weight: 600;
  --main-fg: #ffffff;
  --main-bg: transparent;
  --main-pad: 0;
  --src-fg: #d7dad4;
  --src-bg: transparent;
  --src-pad: 0;
  /* 底板不透明度可调到 0：保留轻微阴影，底板透明时白字仍可读。 */
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
  position: absolute;
  inset: 0;
  pointer-events: none;
  font-family: var(--tt-sans);
  color: #fff;
}
.stage[data-theme="ink"] {
  --badge-bg: rgba(17, 20, 18, 0.86);
  --badge-fg: #e8ece6;
  --badge-muted: #98a098;
  --mark-bg: #6fc39e;
  --mark-fg: #0d1a14;
  --plate-bg: rgba(12, 15, 13, calc(var(--tt-bg-opacity) * 1.1));
  --main-fg: #f2f4ef;
  --src-fg: #8fd6b5;
}
.stage[data-theme="cinema"] {
  --badge-bg: rgba(15, 16, 17, 0.72);
  --badge-fg: #ededee;
  --badge-muted: #a0a5ab;
  --mark-bg: #f2c14e;
  --mark-fg: #1a1400;
  --plate-bg: transparent;
  --plate-pad: 0;
  --gap: 6px;
  --main-font: var(--tt-sans);
  --main-weight: 700;
  --main-fg: #f2c14e;
  --src-fg: #ffffff;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.9), 0 0 12px rgba(0, 0, 0, 0.6);
}
.stage[data-theme="wave"] {
  --badge-bg: #3140e0;
  --badge-fg: #ffffff;
  --badge-muted: rgba(255, 255, 255, 0.82);
  --mark-bg: #ffffff;
  --mark-fg: #3140e0;
  --plate-bg: transparent;
  --plate-pad: 0;
  --gap: 8px;
  --main-font: var(--tt-sans);
  --main-weight: 800;
  --main-fg: #14162b;
  --main-bg: rgba(255, 255, 255, calc(0.8 + var(--tt-bg-opacity) * 0.2));
  --main-pad: calc(var(--tt-font-size) * 0.33) calc(var(--tt-font-size) * 0.67);
  --src-fg: #ffffff;
  --src-bg: rgba(49, 64, 224, calc(0.8 + var(--tt-bg-opacity) * 0.2));
  --src-pad: calc(var(--tt-font-size) * 0.17) calc(var(--tt-font-size) * 0.5);
  --shadow: none;
}
.badge {
  position: absolute;
  top: 12px;
  left: 12px;
  box-sizing: border-box;
  max-width: 60%;
  display: flex;
  align-items: center;
  padding: 4px 10px 4px 5px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--badge-fg);
  background: var(--badge-bg);
  white-space: nowrap;
  overflow: hidden;
}
.mark {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1px;
  width: 18px;
  height: 18px;
  margin-right: 7px;
  border-radius: 5px;
  background: var(--mark-bg);
}
.bar { width: 1.5px; border-radius: 1px; background: var(--mark-fg); }
.bar:nth-child(1) { height: 5px; }
.bar:nth-child(2) { height: 8.6px; }
.bar:nth-child(3) { height: 6.2px; }
.bar:nth-child(4) { height: 3.2px; }
/* 品牌名末尾的分隔空格需要保留（弹性子项会去掉行尾空白）。 */
.brand { flex: none; white-space: pre; }
.label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
  color: var(--badge-muted);
}
.caption {
  position: absolute;
  left: 5%;
  right: 5%;
  bottom: var(--tt-bottom);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  transition: bottom 0.18s ease;
}
.caption[data-position="top"] { top: 8%; bottom: auto; }
.caption[data-position="middle"] { top: 50%; bottom: auto; transform: translateY(-50%); }
.plate {
  box-sizing: border-box;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--gap);
  padding: var(--plate-pad);
  border-radius: calc(var(--tt-font-size) * 0.5);
  background: var(--plate-bg);
}
.line {
  box-sizing: border-box;
  max-width: 100%;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.4;
  text-shadow: var(--shadow);
}
.main {
  padding: var(--main-pad);
  border-radius: calc(var(--tt-font-size) * 0.6);
  font-family: var(--main-font);
  font-size: var(--tt-font-size);
  font-weight: var(--main-weight);
  color: var(--main-fg);
  background: var(--main-bg);
}
.main[data-pending] { opacity: 0.86; }
.main[data-interim] { opacity: 0.78; }
.secondary {
  padding: var(--src-pad);
  border-radius: calc(var(--tt-font-size) * 0.45);
  font-size: calc(var(--tt-font-size) * 0.64);
  font-weight: 500;
  color: var(--src-fg);
  background: var(--src-bg);
}
[hidden] { display: none !important; }
`;
