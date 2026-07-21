/**
 * ManagePanel — the collapsible "Manage channel" section (SRP: kept OUT of the
 * find flow). Three tiers: the shipped CR-04 per-channel policy overrides
 * (qualityCap / subtitleMode via EP-12 — an empty value = "Inherit global" = a
 * `null` patch), the CR-pending "coming soon" chips (curation / quota / content
 * policy — inert), and the EP-38 danger zone (unregister ⟷ re-register / hard
 * purge). Destructive confirms live in the page (it owns ConfirmDialog + toasts);
 * this panel just raises the intents.
 */
import { useTranslation } from 'react-i18next';

import type { ChannelDto, QualityCap, SubtitleMode } from '@tubevault/types';

import { Button, Select } from '../../ds';
import type { ChannelPatch } from './channel-api';
import './ManagePanel.css';

const QUALITY_CAPS: QualityCap[] = ['UNLIMITED', 'P2160', 'P1440', 'P1080', 'P720'];
const SUBTITLE_MODES: SubtitleMode[] = ['NONE', 'MANUAL', 'AUTO', 'BOTH'];
const SOON = ['curation', 'quota', 'contentPolicy'] as const;

export interface ManagePanelProps {
  channel: ChannelDto;
  onSavePolicy: (patch: ChannelPatch) => void;
  onUnregister: () => void;
  onReRegister: () => void;
  onPurge: () => void;
}

export function ManagePanel({
  channel,
  onSavePolicy,
  onUnregister,
  onReRegister,
  onPurge,
}: ManagePanelProps): React.ReactElement {
  const { t } = useTranslation();
  const unregistered = channel.unregisteredAt !== null;

  const qualityOptions = [
    { value: '', label: t('channel.quality.inherit') },
    ...QUALITY_CAPS.map((q) => ({ value: q, label: t(`channel.quality.${q}`) })),
  ];
  const subtitleOptions = [
    { value: '', label: t('channel.subtitle.inherit') },
    ...SUBTITLE_MODES.map((s) => ({ value: s, label: t(`channel.subtitle.${s}`) })),
  ];

  return (
    <section className="tv-manage" data-screen-label="manage-panel">
      <div className="tv-manage__head">
        <span className="tv-manage__title">{t('channel.manage.title')}</span>
        <span className="tv-manage__note">{t('channel.manage.note')}</span>
      </div>

      <div className="tv-manage__policy">
        <Select
          label={t('channel.manage.qualityCap')}
          value={channel.qualityCap ?? ''}
          options={qualityOptions}
          onChange={(v) => onSavePolicy({ qualityCap: v === '' ? null : (v as QualityCap) })}
        />
        <Select
          label={t('channel.manage.subtitles')}
          value={channel.subtitleMode ?? ''}
          options={subtitleOptions}
          onChange={(v) => onSavePolicy({ subtitleMode: v === '' ? null : (v as SubtitleMode) })}
        />
      </div>

      <div className="tv-manage__soon">
        <span className="tv-manage__soon-head">{t('channel.soon.heading')}</span>
        <div className="tv-manage__soon-chips">
          {SOON.map((key) => (
            <span key={key} className="tv-manage__chip">
              {t(`channel.soon.${key}`)}
              <span className="tv-manage__soon-tag">{t('channel.soon.tag')}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="tv-manage__danger">
        <span className="tv-manage__danger-title">{t('channel.danger.zone')}</span>
        <div className="tv-manage__danger-grid">
          <div className="tv-manage__danger-col">
            <span className="tv-manage__danger-desc">{t('channel.danger.unregisterDesc')}</span>
            {unregistered ? (
              <Button variant="secondary" size="sm" onClick={onReRegister}>
                {t('channel.reRegister')}
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={onUnregister}>
                {t('channel.danger.unregister')}
              </Button>
            )}
          </div>
          <div className="tv-manage__danger-col">
            <span className="tv-manage__danger-desc">{t('channel.danger.purgeDesc')}</span>
            <Button variant="danger" size="sm" icon="trash" onClick={onPurge}>
              {t('channel.danger.purge')}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
