/**
 * 页面级错误边界：渲染异常时显示可操作的提示，而不是空白页面。不展示堆栈。
 * 位于语言 Provider 之外，文案使用页面根部同步的当前语言（getLocale）。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { getLocale, translate } from '../../i18n';
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
    const locale = getLocale();
    return (
      <EmptyState
        title={translate(locale, 'common.errorBoundary.title')}
        actions={
          <Button variant="primary" onClick={() => window.location.reload()}>
            {translate(locale, 'common.errorBoundary.reload')}
          </Button>
        }
      >
        {translate(locale, 'common.errorBoundary.body')}
      </EmptyState>
    );
  }
}
