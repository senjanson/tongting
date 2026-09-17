import { defineBackground } from 'wxt/utils/define-background';
import { startBackground } from '../src/background/wiring';

export default defineBackground({
  type: 'module',
  main() {
    // 监听器在 startBackground 内同步注册，满足 MV3 worker 唤醒要求。
    startBackground();
  },
});
