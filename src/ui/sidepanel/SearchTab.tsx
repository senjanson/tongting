import { Check, ChevronRight, Copy, History, Pencil, Search, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SEARCH_HISTORY_LIMIT,
  SEARCH_KEYWORD_MAX_LENGTH,
  SearchInputSchema,
  SearchKeywordSchema,
  type SearchRecord,
} from '../../domain/search';
import { randomId } from '../../messaging/ports';
import { Button, IconButton } from '../components/controls';
import { useToast } from '../components/toast';
import { copyText } from '../shared/clipboard';
import { openYouTubeSearch } from '../shared/navigation';
import { errorInfoOf, errorMessageOf } from '../state/client';
import { deriveServiceConfig } from '../state/derive';
import { useClientState, useUiClient } from '../state/hooks';
import styles from './search.module.css';

export function SearchTab({
  onOpenSettings,
  query,
  onQueryChange: setQuery,
}: {
  onOpenSettings(): void;
  query: string;
  onQueryChange(value: string): void;
}) {
  const client = useUiClient();
  const { snapshot, connection } = useClientState();
  const config = deriveServiceConfig(snapshot);
  const notify = useToast();
  const [record, setRecord] = useState<SearchRecord | null>(null);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<SearchRecord[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [clearing, setClearing] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editError, setEditError] = useState('');
  const [opening, setOpening] = useState<number | null>(null);
  const operation = useRef<string | null>(null);
  const historyVersion = useRef({ value: 0 });
  const mounted = useRef(false);
  const openingRef = useRef(false);

  const loadHistory = useCallback(async () => {
    const version = ++historyVersion.current.value;
    try {
      const result = await client.sendCommand({ kind: 'search/history' });
      if (!mounted.current || version !== historyVersion.current.value) return;
      setHistory(result.records);
      setHistoryError('');
    } catch {
      if (mounted.current && version === historyVersion.current.value)
        setHistoryError('最近生成记录未能读取，请稍后重新展开。');
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    const generation = historyVersion.current;
    return () => {
      mounted.current = false;
      generation.value++;
      const id = operation.current;
      operation.current = null;
      if (id)
        void client.sendCommand({ kind: 'search/cancel', operationId: id }).catch(() => undefined);
    };
  }, [client]);

  useEffect(() => {
    let active = true;
    // Delay the repository read until after this effect; cleanup prevents a read after leaving.
    void Promise.resolve().then(() => {
      if (active && connection === 'connected') void loadHistory();
    });
    return () => {
      active = false;
    };
  }, [connection, loadHistory]);

  function cancel() {
    const id = operation.current;
    operation.current = null;
    setBusy(false);
    if (id)
      void client.sendCommand({ kind: 'search/cancel', operationId: id }).catch(() => undefined);
  }

  function display(next: SearchRecord) {
    setRecord(next);
    setKeywords(next.items.map((item) => item.keyword));
    setEditing(null);
    setEditError('');
  }

  async function generate() {
    if (operation.current || clearing || connection !== 'connected' || !config.ready) return;
    const input = SearchInputSchema.safeParse(query);
    if (!input.success) {
      setError('请输入 1–300 字的搜索内容。');
      return;
    }
    const id = randomId('search');
    operation.current = id;
    setBusy(true);
    setError('');
    setEditing(null);
    try {
      const result = await client.sendCommand({
        kind: 'search/generate',
        operationId: id,
        query: input.data,
      });
      if (!mounted.current || operation.current !== id) return;
      display(result.record);
      historyVersion.current.value++;
      if (result.persisted) {
        setHistory((old) =>
          [result.record, ...old.filter((item) => item.query !== result.record.query)].slice(
            0,
            SEARCH_HISTORY_LIMIT,
          ),
        );
        setHistoryError('');
      } else setHistoryError('搜索词已生成，但历史记录保存失败；当前仍可复制和搜索。');
    } catch (failure) {
      if (mounted.current && operation.current === id)
        setError(
          errorInfoOf(failure)?.category === 'cancelled'
            ? '请求已取消或服务配置发生变化，请重新生成。'
            : errorMessageOf(failure),
        );
    } finally {
      if (operation.current === id) {
        operation.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }

  function saveEdit(index: number) {
    const parsed = SearchKeywordSchema.safeParse(editDraft);
    if (!parsed.success) {
      setEditError(`请输入 1–${SEARCH_KEYWORD_MAX_LENGTH} 字符的单行英文搜索词。`);
      return;
    }
    setKeywords((old) => old.map((value, i) => (i === index ? parsed.data : value)));
    setEditing(null);
    setEditError('');
  }

  async function search(index: number) {
    if (openingRef.current) return;
    if (client.mode === 'demo') {
      notify('演示模式不打开真实搜索页面。', 'info');
      return;
    }
    openingRef.current = true;
    setOpening(index);
    try {
      await openYouTubeSearch(keywords[index]!);
    } catch {
      if (mounted.current) notify('未能打开 YouTube 搜索，请重试或复制关键词。', 'danger');
    } finally {
      openingRef.current = false;
      if (mounted.current) setOpening(null);
    }
  }

  async function clearHistory() {
    if (clearing) return;
    cancel();
    historyVersion.current.value++;
    setClearing(true);
    try {
      await client.sendCommand({ kind: 'search/clear-history' });
      if (mounted.current) {
        historyVersion.current.value++;
        setHistory([]);
        setHistoryError('');
      }
    } catch {
      if (mounted.current) setHistoryError('清空失败，历史记录仍保留，请重试。');
    } finally {
      if (mounted.current) setClearing(false);
    }
  }

  return (
    <div className={styles.pane}>
      <h2 className={styles.title}>用中文，搜英文</h2>
      <p className={styles.intro}>说出你想看的内容，找到更合适的搜索词。</p>
      {!config.ready && (
        <div className={styles.config} role="status">
          <p>{config.message || '请先在设置中配置翻译服务。'}</p>
          <Button size="sm" onClick={onOpenSettings}>
            打开设置
          </Button>
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void generate();
        }}
      >
        <label className={styles.label} htmlFor="search-topic">
          你想在 YouTube 上找什么？
        </label>
        <textarea
          id="search-topic"
          className={styles.input}
          rows={3}
          maxLength={300}
          placeholder="例如：新手怎么用 AI 剪辑 YouTube 视频"
          value={query}
          disabled={busy || clearing}
          onChange={(event) => {
            setQuery(event.target.value);
            setError('');
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.ctrlKey || event.metaKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void generate();
            }
          }}
        />
        <div className={styles.inputMeta}>
          <span>1 条原文直译 + 2 条简短搜索词</span>
          <span>{query.length} / 300</span>
        </div>
        <Button
          type="submit"
          block
          variant="primary"
          busy={busy}
          icon={<Sparkles size={16} aria-hidden="true" />}
          disabled={
            busy || clearing || !query.trim() || !config.ready || connection !== 'connected'
          }
        >
          {busy
            ? '正在生成搜索词…'
            : record?.query === query.trim()
              ? '重新生成英文搜索词'
              : '生成英文搜索词'}
        </Button>
        {busy && (
          <Button block variant="ghost" size="sm" onClick={cancel}>
            取消生成
          </Button>
        )}
      </form>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <section
        className={styles.results}
        aria-label="英文搜索词"
        aria-busy={busy}
        aria-live="polite"
      >
        {record ? (
          <>
            <div className={styles.resultHead}>
              <span>{busy || record.query !== query.trim() ? '上次生成' : '英文搜索词'}</span>
              <span>中文注释 · 可编辑</span>
            </div>
            {(busy || record.query !== query.trim()) && (
              <p className={styles.previous}>{record.query}</p>
            )}
            {record.items.map((item, index) => (
              <article className={styles.result} key={`${record.id}:${index}`}>
                <div className={styles.category}>
                  {String(index + 1).padStart(2, '0')} · {item.label}
                </div>
                {editing === index ? (
                  <>
                    <label className={styles.label} htmlFor={`keyword-${index}`}>
                      编辑英文搜索词
                    </label>
                    <textarea
                      id={`keyword-${index}`}
                      className={styles.input}
                      rows={2}
                      maxLength={SEARCH_KEYWORD_MAX_LENGTH}
                      autoFocus
                      value={editDraft}
                      onChange={(event) => {
                        setEditDraft(event.target.value);
                        setEditError('');
                      }}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          saveEdit(index);
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          setEditing(null);
                        }
                      }}
                    />
                    {editError && (
                      <p className={styles.error} role="alert">
                        {editError}
                      </p>
                    )}
                    <div className={styles.actions}>
                      <Button size="sm" onClick={() => setEditing(null)}>
                        取消
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        icon={<Check size={14} />}
                        onClick={() => saveEdit(index)}
                      >
                        保存
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className={styles.english}>{keywords[index]}</p>
                    <p className={styles.meaning}>{item.annotation}</p>
                    {keywords[index] !== item.keyword && (
                      <p className={styles.editNote}>已编辑 · 中文注释对应原建议</p>
                    )}
                    <div className={styles.actions}>
                      <IconButton
                        label={`编辑搜索词 ${index + 1}`}
                        icon={<Pencil size={14} />}
                        onClick={() => {
                          setEditing(index);
                          setEditDraft(keywords[index]!);
                          setEditError('');
                        }}
                      />
                      <Button
                        size="sm"
                        icon={<Copy size={14} aria-hidden="true" />}
                        onClick={() => {
                          void copyText(keywords[index]!).then((ok) => {
                            if (mounted.current)
                              notify(
                                ok ? '英文搜索词已复制。' : '复制失败，请选中英文词手动复制。',
                                ok ? 'success' : 'warning',
                              );
                          });
                        }}
                      >
                        复制
                      </Button>
                      <Button
                        size="sm"
                        className={styles.searchButton}
                        icon={<Search size={14} aria-hidden="true" />}
                        busy={opening === index}
                        disabled={opening !== null}
                        onClick={() => void search(index)}
                      >
                        搜索
                      </Button>
                    </div>
                  </>
                )}
              </article>
            ))}
          </>
        ) : (
          !busy && (
            <div className={styles.empty}>
              <Search size={21} aria-hidden="true" />
              <p>输入中文后，这里会显示英文搜索词和中文注释。</p>
            </div>
          )
        )}
      </section>
      <details
        className={styles.history}
        onToggle={(event) => {
          if (event.currentTarget.open && !clearing && connection === 'connected')
            void loadHistory();
        }}
      >
        <summary>
          <History size={14} aria-hidden="true" />
          最近生成 <span>{history.length}</span>
        </summary>
        <p className={styles.historyHint}>仅保存在本机，最多 20 条。载入记录不会再次调用 AI。</p>
        {history.length ? (
          <>
            <ul>
              {history.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={styles.historyItem}
                    disabled={clearing}
                    onClick={() => {
                      cancel();
                      setQuery(item.query);
                      display(item);
                      setError('');
                    }}
                  >
                    <span>
                      {item.query}
                      <small>
                        {new Date(item.createdAt).toLocaleDateString('zh-CN')} · {item.model}
                      </small>
                    </span>
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className={styles.historyHint}>还没有生成记录。</p>
        )}
        {(history.length > 0 || historyError) && (
          <Button
            size="sm"
            variant="ghost"
            busy={clearing}
            disabled={clearing || connection !== 'connected'}
            icon={<X size={14} aria-hidden="true" />}
            onClick={() => void clearHistory()}
          >
            清空历史记录
          </Button>
        )}
      </details>
      {historyError && (
        <p className={styles.error} role="status">
          {historyError}
        </p>
      )}
      {client.mode === 'demo' && (
        <p className={styles.historyHint}>演示使用固定示例，不调用 AI，也不打开真实搜索。</p>
      )}
    </div>
  );
}
