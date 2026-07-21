/**
 * ChannelFilter — S4's cross-channel narrowing control. A native DS <Select>
 * ("All channels" default + one option per registered channel) that fetches its
 * own options from EP-11 (getChannels) once on mount. The SELECTED value + change
 * handler are owned by the shared useVideosBrowser (channelId), so this component
 * is a pure options-provider: a load failure degrades to "All channels" only
 * (never blocks the browser — the whole-library view still works).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ChannelDto } from '@tubevault/types';

import { Select } from '../../ds';
import { getChannels } from '../channels/channels-api';

export interface ChannelFilterProps {
  value: string;
  onChange: (channelId: string) => void;
}

export function ChannelFilter({ value, onChange }: ChannelFilterProps): React.ReactElement {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    getChannels()
      .then((res) => {
        if (alive.current) setChannels(res.channels);
      })
      .catch(() => {
        /* degrade to "All channels" only — the library view still works */
      });
    return () => {
      alive.current = false;
    };
  }, []);

  const options = useMemo(
    () => [
      { value: '', label: t('videos.filter.allChannels') },
      ...channels.map((c) => ({ value: c.id, label: c.title })),
    ],
    [channels, t],
  );

  return (
    <Select
      label={t('library.channelFilter')}
      value={value}
      onChange={onChange}
      options={options}
    />
  );
}
