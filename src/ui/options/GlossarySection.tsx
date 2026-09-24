/**
 * 术语表编辑：本地草稿，校验后整体保存。
 */
import { ArrowRight, Plus, Save, Undo2, X } from 'lucide-react';
import { useState } from 'react';
import type { GlossaryEntry } from '../../domain/settings';
import { useLocale, useT } from '../../i18n/react';
import { Button, controlStyles, Hint, IconButton } from '../components/controls';
import { useSettingsUpdater } from '../shared/hooks';
import { Section } from './common';
import { validateGlossary, type GlossaryDraftRow } from './glossary';
import styles from './options.module.css';

function toRows(entries: readonly GlossaryEntry[], startKey = 1): GlossaryDraftRow[] {
  return entries.map((e, i) => ({ key: startKey + i, source: e.source, target: e.target }));
}

export function GlossarySection({ glossary }: { glossary: readonly GlossaryEntry[] }) {
  const t = useT();
  const locale = useLocale();
  const update = useSettingsUpdater();
  const [draft, setDraft] = useState<{ rows: GlossaryDraftRow[]; nextKey: number } | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const rows = draft?.rows ?? toRows(glossary);
  const nextKey = draft?.nextKey ?? glossary.length + 1;
  const validation = validateGlossary(rows, locale);

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
      title={t('options.section.glossary')}
      description={t('options.glossary.description')}
    >
      <div className={styles.glossary}>
        {rows.length === 0 && <Hint>{t('options.glossary.empty')}</Hint>}
        {rows.map((row, index) => {
          const error = showErrors && !validation.ok ? validation.errors.get(row.key) : undefined;
          return (
            <div key={row.key}>
              <div className={styles.glossaryRow}>
                <input
                  className={controlStyles.input}
                  aria-label={t('options.glossary.sourceAria', { n: index + 1 })}
                  placeholder={t('options.glossary.sourcePlaceholder')}
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
                  aria-label={t('options.glossary.targetAria', { n: index + 1 })}
                  placeholder={t('options.glossary.targetPlaceholder')}
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
                  label={t('options.glossary.deleteAria', { n: index + 1 })}
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
          {t('options.glossary.add')}
        </Button>
        <Button
          variant="primary"
          icon={<Save size={15} aria-hidden="true" />}
          disabled={!draft}
          onClick={() => void save()}
        >
          {t('options.glossary.save')}
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
            {t('options.glossary.discard')}
          </Button>
        )}
      </div>
      {showErrors && !validation.ok && <Hint tone="error">{validation.message}</Hint>}
    </Section>
  );
}
