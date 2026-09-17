/**
 * 页面级错误边界：渲染异常时显示可操作的提示，而不是空白页面。不展示堆栈。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './controls';
import { EmptyState } from './layout';

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(
      '[tongting] UI render error',
      error instanceof Error ? error.message : error,
      info.componentStack?.slice(0, 500),
    );
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <EmptyState
        title="界面出现错误"
        actions={
          <Button variant="primary" onClick={() => window.location.reload()}>
            重新加载此页面
          </Button>
        }
      >
        正在进行的翻译不受影响（由后台管理）。重新加载后会从后台重新读取真实状态。
      </EmptyState>
    );
  }
}
