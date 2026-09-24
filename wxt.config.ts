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
  // 名称、说明、按钮提示与快捷键说明按浏览器语言显示，文案见 public/_locales/*/messages.json。
  manifest: {
    default_locale: 'en',
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    minimum_chrome_version: '116',
    permissions: ['storage', 'sidePanel', 'activeTab', 'tabCapture', 'offscreen', 'tts'],
    // 用户配置的服务 origin 在设置页按需申请，只申请单一 origin。
    optional_host_permissions: ['https://*/*', 'http://127.0.0.1/*'],
    ...(isE2E ? { host_permissions: ['http://127.0.0.1/*'] } : {}),
    homepage_url: 'https://github.com/senjanson/tongting',
    action: {
      default_title: '__MSG_actionTitle__',
    },
    commands: {
      'toggle-translation': {
        suggested_key: { default: 'Alt+T' },
        description: '__MSG_commandToggleTranslation__',
      },
      'toggle-captions': {
        suggested_key: { default: 'Alt+C' },
        description: '__MSG_commandToggleCaptions__',
      },
    },
  },
  hooks: {
    // WXT 默认用弹窗页面的 <title> 作为按钮提示，这里改回按浏览器语言显示的文案。
    'build:manifestGenerated': (_wxt, manifest) => {
      if (manifest.action) manifest.action.default_title = '__MSG_actionTitle__';
    },
  },
  webExt: {
    disabled: true,
  },
});
