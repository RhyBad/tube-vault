/**
 * GlobalDefaultsSection — Section 1's view (EP-07/08). Explicit save: the stepper
 * (1–4) and the two selects edit a draft; "Save changes" enables only when dirty
 * and sends the partial PATCH. After a save the section shows a "Saved" flash, and
 * if the server clamped concurrency, a one-off notice explains the adjustment.
 */
import { useTranslation } from 'react-i18next';

import type { SettingsDto } from '@tubevault/types';

import { Button, Icon, NumberStepper, Select, type SelectOption } from '../../ds';
import { SettingsSectionCard } from './SettingsSectionCard';
import type { UseGlobalDefaultsResult } from './useGlobalDefaults';

const QUALITY_VALUES: ReadonlyArray<SettingsDto['qualityCap']> = [
  'UNLIMITED',
  'P2160',
  'P1440',
  'P1080',
  'P720',
];
const SUBTITLE_VALUES: ReadonlyArray<SettingsDto['subtitleMode']> = [
  'NONE',
  'MANUAL',
  'AUTO',
  'BOTH',
];

export interface GlobalDefaultsSectionProps {
  index: number;
  defaults: UseGlobalDefaultsResult;
}

export function GlobalDefaultsSection({
  index,
  defaults,
}: GlobalDefaultsSectionProps): React.ReactElement {
  const { t } = useTranslation();
  const { draft } = defaults;

  const qualityOptions: SelectOption[] = QUALITY_VALUES.map((v) => ({
    value: v,
    label: t(`settings.defaults.quality_opts.${v}`),
  }));
  const subtitleOptions: SelectOption[] = SUBTITLE_VALUES.map((v) => ({
    value: v,
    label: t(`settings.defaults.subtitle_opts.${v}`),
  }));

  return (
    <SettingsSectionCard
      index={index}
      eyebrow={t('settings.defaults.eyebrow')}
      title={t('settings.defaults.title')}
      description={t('settings.defaults.desc')}
      epLabel={t('settings.defaults.ep')}
      phase={defaults.phase}
      onRetry={defaults.retry}
    >
      {draft !== null && (
        <div className="tv-set__body">
          <div className="tv-set-defaults__grid">
            <div className="tv-set-field">
              <span className="tv-set-field__label">
                {t('settings.defaults.concurrency.label')}
              </span>
              <NumberStepper
                value={draft.downloadConcurrency}
                min={1}
                max={4}
                suffix="×"
                disabled={defaults.saving}
                onChange={defaults.setConcurrency}
              />
              <span className="tv-set-field__hint">{t('settings.defaults.concurrency.hint')}</span>
              {defaults.clamp !== null && (
                <div className="tv-set-clamp" role="status">
                  <Icon name="alert" size={14} className="tv-set-clamp__icon" />
                  <span>{t('settings.defaults.clamp', { to: defaults.clamp })}</span>
                </div>
              )}
            </div>

            <div className="tv-set-field">
              <span className="tv-set-field__label">{t('settings.defaults.quality.label')}</span>
              <Select
                value={draft.qualityCap}
                options={qualityOptions}
                disabled={defaults.saving}
                onChange={(v) => defaults.setQualityCap(v as SettingsDto['qualityCap'])}
              />
            </div>

            <div className="tv-set-field">
              <span className="tv-set-field__label">{t('settings.defaults.subtitles.label')}</span>
              <Select
                value={draft.subtitleMode}
                options={subtitleOptions}
                disabled={defaults.saving}
                onChange={(v) => defaults.setSubtitleMode(v as SettingsDto['subtitleMode'])}
              />
            </div>
          </div>

          <div className="tv-set-defaults__foot">
            <Button
              variant="primary"
              onClick={defaults.save}
              disabled={!defaults.dirty || defaults.saving}
            >
              {defaults.saving ? t('settings.common.saving') : t('settings.common.save')}
            </Button>
            {defaults.justSaved && (
              <span className="tv-set-saved" role="status">
                <Icon name="check" size={14} />
                {t('settings.common.saved')}
              </span>
            )}
            {defaults.dirty && !defaults.saving && (
              <span className="tv-set-unsaved">{t('settings.common.unsaved')}</span>
            )}
            {defaults.saveError !== null && (
              <span className="tv-set-field__error" role="alert">
                {defaults.saveError}
              </span>
            )}
          </div>
        </div>
      )}
    </SettingsSectionCard>
  );
}
