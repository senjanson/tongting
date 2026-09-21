/**
 * 术语表编辑：本地草稿，校验后整体保存。
 */
import { ArrowRight, Plus, Save, Undo2, X } from 'lucide-react';
import { useState } from 'react';
import type { GlossaryEntry } from '../../domain/settings';
import { Button, controlStyles, Hint, IconButton } from '../components/controls';
import { useSettingsUpdater } from '../shared/hooks';
import { Section } from './common';
import { validateGlossary, type GlossaryDraftRow } from './glossary';
import styles from './options.module.css';

function toRows(entries: readonly GlossaryEntry[], startKey = 1): GlossaryDraftRow[] {
  return entries.map((e, i) => ({ key: startKey + i, source: e.source, target: e.target }));
}

export function GlossarySection({ glossary }: { glossary: readonly GlossaryEntry[] }) {
  const update = useSettingsUpdater();
  const [draft, setDraft] = useState<{ rows: GlossaryDraftRow[]; nextKey: number } | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const rows = draft?.rows ?? toRows(glossary);
  const nextKey = draft?.nextKey ?? glossary.length + 1;
  const validation = validateGlossary(rows);

  const edit = (next: GlossaryDraftRow[], key = nextKey) => setDraft({ rows: next, nextKey: key });

  const save = async () => {
    setShowErrors(true);
    if (!validation.ok) return;
    if (await update({ glossary: validation.entries })) {
      setDraft((current) => (current === draft ? null : current));
      setShowErrors(false);
    }
  };

  return (
    <Section
      id="glossary"
      title="术语表"
      description="固定人名、产品名等译法。术语表会随翻译请求发送给模型；修改后旧的缓存译文不会用于新配置。"
    >
      <div className={styles.glossary}>
        {rows.length === 0 && <Hint>还没有术语。</Hint>}
        {rows.map((row, index) => {
          const error = showErrors && !validation.ok ? validation.errors.get(row.key) : undefined;
          return (
            <div key={row.key}>
              <div className={styles.glossaryRow}>
                <input
                  className={controlStyles.input}
                  aria-label={`第 ${index + 1} 条原文`}
                  placeholder="原文"
                  value={row.source}
                  maxLength={200}
                  aria-invalid={error ? true : undefined}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    edit(rows.map((r) => (r.key === row.key ? { ...r, source: value } : r)));
                  }}
                />
                <ArrowRight size={14} aria-hidden="true" />
                <input
                  className={controlStyles.input}
                  aria-label={`第 ${index + 1} 条译文`}
                  placeholder="译文"
                  value={row.target}
                  maxLength={200}
                  aria-invalid={error ? true : undefined}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    edit(rows.map((r) => (r.key === row.key ? { ...r, target: value } : r)));
                  }}
                />
                <IconButton
                  bare
                  label={`删除第 ${index + 1} 条术语`}
                  icon={<X size={15} aria-hidden="true" />}
                  onClick={() => edit(rows.filter((r) => r.key !== row.key))}
                />
              </div>
              {error && <Hint tone="error">{error}</Hint>}
            </div>
          );
        })}
      </div>
      <div className={styles.row}>
        <Button
          icon={<Plus size={15} aria-hidden="true" />}
          onClick={() => edit([...rows, { key: nextKey, source: '', target: '' }], nextKey + 1)}
        >
          添加术语
        </Button>
        <Button
          variant="primary"
          icon={<Save size={15} aria-hidden="true" />}
          disabled={!draft}
          onClick={() => void save()}
        >
          保存术语表
        </Button>
        {draft && (
          <Button
            variant="ghost"
            icon={<Undo2 size={15} aria-hidden="true" />}
            onClick={() => {
              setDraft(null);
              setShowErrors(false);
            }}
          >
            放弃修改
          </Button>
        )}
      </div>
      {showErrors && !validation.ok && <Hint tone="error">{validation.message}</Hint>}
    </Section>
  );
}
