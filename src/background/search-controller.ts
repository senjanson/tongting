import { AppError, cancelledError } from '../domain/errors';
import {
  SearchInputSchema,
  SearchLanguageSchema,
  SearchRecordSchema,
  type SearchLanguages,
  type SearchRecord,
} from '../domain/search';
import { withRequestSignal } from '../providers/text/http';
import type {
  generateSearchKeywords,
  SearchGenerationParams,
} from '../providers/text/search-keywords';
import type { SearchHistoryRepo } from '../storage/search-history';
import { t } from '../i18n';

type SearchRoute = Omit<
  SearchGenerationParams,
  'query' | 'signal' | 'userLanguage' | 'keywordLanguage'
>;
export class SearchController {
  private readonly operations = new Map<object, { id: string; abort: AbortController }>();
  constructor(
    private readonly deps: {
      route(signal: AbortSignal): Promise<SearchRoute>;
      generate: typeof generateSearchKeywords;
      history: SearchHistoryRepo;
      now(): number;
      randomId(prefix?: string): string;
      detected(protocol: 'responses' | 'chat'): void;
    },
  ) {}

  cancel(owner: object, id?: string): void {
    const current = this.operations.get(owner);
    if (!current || (id !== undefined && current.id !== id)) return;
    current.abort.abort();
    this.operations.delete(owner);
  }
  cancelAll(): void {
    for (const owner of this.operations.keys()) this.cancel(owner);
  }

  async generate(
    owner: object,
    id: string,
    input: string,
    languages: SearchLanguages,
  ): Promise<{ record: SearchRecord; persisted: boolean }> {
    const query = SearchInputSchema.parse(input);
    const userLanguage = SearchLanguageSchema.parse(languages.userLanguage);
    const keywordLanguage = SearchLanguageSchema.parse(languages.keywordLanguage);
    this.cancel(owner);
    if (this.operations.size >= 4)
      throw new AppError({
        code: 'search-busy',
        category: 'config',
        retryable: true,
        message: t('background.search.tooMany'),
      });
    const operation = { id, abort: new AbortController() };
    this.operations.set(owner, operation);
    try {
      return await withRequestSignal(operation.abort.signal, 125_000, async (signal) => {
        const check = () => {
          if (signal.aborted || this.operations.get(owner) !== operation) throw cancelledError();
        };
        const route = await this.deps.route(signal);
        check();
        const result = await this.deps.generate({
          ...route,
          query,
          userLanguage,
          keywordLanguage,
          signal,
        });
        check();
        const record = SearchRecordSchema.parse({
          id: this.deps.randomId('search'),
          query,
          items: result.items,
          model: result.model,
          createdAt: this.deps.now(),
          userLanguage,
          keywordLanguage,
        });
        this.deps.detected(result.protocol);
        let persisted = true;
        try {
          await this.deps.history.save(record, signal);
        } catch {
          check();
          persisted = false;
        }
        check();
        return { record, persisted };
      });
    } finally {
      if (this.operations.get(owner) === operation) this.operations.delete(owner);
    }
  }
  async list(): Promise<{ records: SearchRecord[] }> {
    return { records: await this.deps.history.list() };
  }
  async clear(): Promise<{ cleared: true }> {
    this.cancelAll();
    await this.deps.history.clear();
    return { cleared: true };
  }
}
