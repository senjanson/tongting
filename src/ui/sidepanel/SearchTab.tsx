import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  History,
  Pencil,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_TARGET_LANGUAGE,
  TARGET_LANGUAGES,
  primaryLanguageTag,
} from '../../domain/languages';
import {
  DEFAULT_SEARCH_KEYWORD_LANGUAGE,
  SEARCH_HISTORY_LIMIT,
  SEARCH_KEYWORD_MAX_LENGTH,
  SearchInputSchema,
  SearchKeywordSchema,
  resolveSearchLanguages,
  searchRecordLanguages,
  type SearchLanguages,
  type SearchRecord,
} from '../../domain/search';
import { translate, type Locale } from '../../i18n';
import { useLocale, useT } from '../../i18n/react';
import { randomId } from '../../messaging/ports';
import { Button, IconButton, SelectField } from '../components/controls';
import { Callout, Card } from '../components/layout';
import { useToast } from '../components/toast';
import { formatDate, languageLabel, searchLanguageName } from '../format';
import { copyText } from '../shared/clipboard';
import { useSettingsUpdater } from '../shared/hooks';
import { openYouTubeSearch } from '../shared/navigation';
import { errorInfoOf, errorMessageOf } from '../state/client';
import { deriveServiceConfig } from '../state/derive';
import { useClientState, useUiClient } from '../state/hooks';
import styles from './search.module.css';

/** 界面文案中的两种语言名；同为中文时区分简繁。 */
function languageNames({ userLanguage, keywordLanguage }: SearchLanguages, locale: Locale) {
  return {
    user: searchLanguageName(userLanguage, keywordLanguage, locale),
    keyword: searchLanguageName(keywordLanguage, userLanguage, locale),
  };
}

function sameLanguages(a: SearchLanguages, b: SearchLanguages): boolean {
  return a.userLanguage === b.userLanguage && a.keywordLanguage === b.keywordLanguage;
}

function historyLanguages(record: SearchRecord, locale: Locale): string {
  const names = languageNames(searchRecordLanguages(record), locale);
  return `${names.user} → ${names.keyword}`;
}

/** 示例用用户所选的输入语言书写（中文、英文有现成示例），其他语言显示界面语言的说明。 */
function placeholderFor(userLanguage: string, userName: string, locale: Locale): string {
  switch (primaryLanguageTag(userLanguage)) {
    case 'zh':
      return '例如：新手怎么用 AI 剪辑 YouTube 视频';
    case 'en':
      return 'e.g. How can beginners edit YouTube videos with AI?';
    default:
      return translate(locale, 'sidepanel.search.placeholder', { language: userName });
  }
}

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
  const updateSettings = useSettingsUpdater();
  const locale = useLocale();
  const t = useT();
  const languageOptions = useMemo(
    () => TARGET_LANGUAGES.map((l) => ({ value: l.code, label: languageLabel(l.code, locale) })),
    [locale],
  );
  // 设置未载入时只用于显示；生成按钮在此之前不可用。
  const languages: SearchLanguages = snapshot
    ? resolveSearchLanguages(snapshot.settings)
    : { userLanguage: DEFAULT_TARGET_LANGUAGE, keywordLanguage: DEFAULT_SEARCH_KEYWORD_LANGUAGE };
  const names = languageNames(languages, locale);
  const sameLanguage = languages.userLanguage === languages.keywordLanguage;
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
        setHistoryError(t('sidepanel.search.historyLoadFailed'));
    }
  }, [client, t]);

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
      setError(t('sidepanel.search.inputInvalid'));
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
        // 携带界面当前显示的语言：刚切换、设置尚未写回时也按用户看到的语言生成。
        userLanguage: languages.userLanguage,
        keywordLanguage: languages.keywordLanguage,
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
      } else setHistoryError(t('sidepanel.search.historySaveFailed'));
    } catch (failure) {
      if (mounted.current && operation.current === id)
        setError(
          errorInfoOf(failure)?.category === 'cancelled'
            ? t('sidepanel.search.cancelled')
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
      setEditError(t('sidepanel.search.keywordInvalid', { max: SEARCH_KEYWORD_MAX_LENGTH }));
      return;
    }
    setKeywords((old) => old.map((value, i) => (i === index ? parsed.data : value)));
    setEditing(null);
    setEditError('');
  }

  async function search(index: number) {
    if (openingRef.current) return;
    if (client.mode === 'demo') {
      notify(t('sidepanel.search.demoNoOpen'), 'info');
      return;
    }
    openingRef.current = true;
    setOpening(index);
    try {
      await openYouTubeSearch(keywords[index]!);
    } catch {
      if (mounted.current) notify(t('sidepanel.search.openFailed'), 'danger');
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
      if (mounted.current) setHistoryError(t('sidepanel.search.clearFailed'));
    } finally {
      if (mounted.current) setClearing(false);
    }
  }

  const recordNames = record ? languageNames(searchRecordLanguages(record), locale) : names;
  const current =
    !!record &&
    record.query === query.trim() &&
    sameLanguages(searchRecordLanguages(record), languages);
  const languageDisabled = busy || clearing || !snapshot || connection !== 'connected';

  return (
    <div className={styles.pane}>
      <div className={styles.head}>
        <h2 className={styles.title}>
          {t('sidepanel.search.title', { user: names.user, keyword: names.keyword })}
        </h2>
        <p className={styles.intro}>{t('sidepanel.search.intro')}</p>
      </div>
      {!config.ready && (
        <Callout
          tone="warning"
          live
          actions={
            <Button size="sm" onClick={onOpenSettings}>
              {t('common.openSettings')}
            </Button>
          }
        >
          {config.message || t('sidepanel.search.configFallback')}
        </Callout>
      )}
      <Card>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void generate();
          }}
        >
          <div className={styles.languages}>
            <SelectField
              label={t('sidepanel.search.userLanguage')}
              value={languages.userLanguage}
              options={languageOptions}
              disabled={languageDisabled}
              onChange={(userLanguage) => void updateSettings({ search: { userLanguage } })}
            />
            <span className={styles.arrow} aria-hidden="true">
              <ArrowRight size={15} />
            </span>
            <SelectField
              label={t('sidepanel.search.keywordLanguage')}
              value={languages.keywordLanguage}
              options={languageOptions}
              disabled={languageDisabled}
              onChange={(keywordLanguage) => void updateSettings({ search: { keywordLanguage } })}
            />
          </div>
          <label className={styles.label} htmlFor="search-topic">
            {t('sidepanel.search.question')}
          </label>
          <textarea
            id="search-topic"
            className={styles.input}
            rows={3}
            maxLength={300}
            placeholder={placeholderFor(languages.userLanguage, names.user, locale)}
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
            <span>
              {sameLanguage ? t('sidepanel.search.metaSame') : t('sidepanel.search.metaDiff')}
            </span>
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
              ? t('sidepanel.search.generating')
              : current
                ? t('sidepanel.search.regenerate', { keyword: names.keyword })
                : t('sidepanel.search.generate', { keyword: names.keyword })}
          </Button>
          {busy && (
            <Button block variant="ghost" size="sm" onClick={cancel}>
              {t('sidepanel.search.cancel')}
            </Button>
          )}
        </form>
      </Card>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <section
        className={styles.results}
        aria-label={t('sidepanel.search.keywords', { keyword: recordNames.keyword })}
        aria-busy={busy}
        aria-live="polite"
      >
        {record ? (
          <>
            <div className={styles.resultHead}>
              <span>
                {busy || !current
                  ? t('sidepanel.search.previous')
                  : t('sidepanel.search.keywords', { keyword: recordNames.keyword })}
              </span>
              <span>{t('sidepanel.search.notes', { user: recordNames.user })}</span>
            </div>
            {(busy || !current) && (
              <p className={styles.previous}>
                {record.query}
                {!sameLanguages(searchRecordLanguages(record), languages) &&
                  ` · ${recordNames.user} → ${recordNames.keyword}`}
              </p>
            )}
            <Card className={styles.resultList}>
              {record.items.map((item, index) => (
                <article className={styles.result} key={`${record.id}:${index}`}>
                  <div className={styles.category}>
                    {String(index + 1).padStart(2, '0')} · {item.label}
                  </div>
                  {editing === index ? (
                    <>
                      <label className={styles.label} htmlFor={`keyword-${index}`}>
                        {t('sidepanel.search.editLabel', { keyword: recordNames.keyword })}
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
                          {t('common.cancel')}
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          icon={<Check size={14} />}
                          onClick={() => saveEdit(index)}
                        >
                          {t('common.save')}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className={styles.english}>{keywords[index]}</p>
                      <p className={styles.meaning}>{item.annotation}</p>
                      {keywords[index] !== item.keyword && (
                        <p className={styles.editNote}>
                          {t('sidepanel.search.edited', { user: recordNames.user })}
                        </p>
                      )}
                      <div className={styles.actions}>
                        <IconButton
                          label={t('sidepanel.search.editAria', { index: index + 1 })}
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
                                  ok
                                    ? t('sidepanel.search.copied', { keyword: recordNames.keyword })
                                    : t('sidepanel.search.copyFailed'),
                                  ok ? 'success' : 'warning',
                                );
                            });
                          }}
                        >
                          {t('common.copy')}
                        </Button>
                        <Button
                          size="sm"
                          className={styles.searchButton}
                          icon={<Search size={14} aria-hidden="true" />}
                          busy={opening === index}
                          disabled={opening !== null}
                          onClick={() => void search(index)}
                        >
                          {t('common.search')}
                        </Button>
                      </div>
                    </>
                  )}
                </article>
              ))}
            </Card>
          </>
        ) : (
          !busy && (
            <div className={styles.empty}>
              <Search size={21} aria-hidden="true" />
              <p>
                {sameLanguage
                  ? t('sidepanel.search.emptySame', { user: names.user })
                  : t('sidepanel.search.emptyDiff', { user: names.user, keyword: names.keyword })}
              </p>
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
          <History size={16} aria-hidden="true" />
          <span className={styles.summaryLabel}>{t('sidepanel.search.recent')}</span>
          <span className={styles.count}>{history.length}</span>
          <ChevronDown size={16} aria-hidden="true" className={styles.summaryChevron} />
        </summary>
        <p className={styles.historyHint}>{t('sidepanel.search.historyHint')}</p>
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
                        {formatDate(item.createdAt, locale)} · {historyLanguages(item, locale)} ·{' '}
                        {item.model}
                      </small>
                    </span>
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className={styles.historyHint}>{t('sidepanel.search.historyEmpty')}</p>
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
            {t('sidepanel.search.clearHistory')}
          </Button>
        )}
      </details>
      {historyError && (
        <p className={styles.error} role="status">
          {historyError}
        </p>
      )}
      {client.mode === 'demo' && (
        <p className={styles.historyHint}>{t('sidepanel.search.demoHint')}</p>
      )}
    </div>
  );
}
