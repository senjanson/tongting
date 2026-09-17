import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

// 仅供自动化端到端测试的构建变体：输出到独立目录，并对本机 mock 服务预授予主机权限
// （自动化无法点击浏览器权限弹窗）。生产构建不包含这些权限。
const isE2E = process.env.TONGTING_E2E === '1';

// 权限说明见 docs/CAPABILITIES.md「权限」一节。
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  outDir: isE2E ? '.output-e2e' : '.output',
  imports: false,
  alias: {
    '@src': resolve(__dirname, 'src'),
  },
  manifest: {
    name: '同听 Tongting',
    description: 'YouTube 中文翻译字幕与配音（使用你自己的 sub2api 服务）',
    minimum_chrome_version: '116',
    permissions: ['storage', 'sidePanel', 'activeTab', 'tabCapture', 'offscreen', 'tts'],
    // 用户配置的服务 origin 在设置页按需申请，只申请单一 origin。
    optional_host_permissions: ['https://*/*', 'http://127.0.0.1/*'],
    ...(isE2E ? { host_permissions: ['http://127.0.0.1/*'] } : {}),
    action: {
      default_title: '同听',
    },
    commands: {
      'toggle-translation': {
        suggested_key: { default: 'Alt+T' },
        description: '暂停 / 继续翻译',
      },
      'toggle-captions': {
        suggested_key: { default: 'Alt+C' },
        description: '显示 / 隐藏翻译字幕',
      },
    },
  },
  webExt: {
    disabled: true,
  },
});
