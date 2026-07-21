/**
 * WatchLiveToggle — the live-watch switch in a channel row's footer (EP-12). A
 * real switch control (role="switch", keyboard-operable via the native button);
 * the DS has no Switch primitive, so this is a small token-styled toggle shared
 * with the S7 pattern. The aria-label carries the channel name + target state so
 * a screen-reader user hears what they're flipping.
 */
import { useTranslation } from 'react-i18next';

export interface WatchLiveToggleProps {
  on: boolean;
  /** Channel title, woven into the accessible label. */
  name: string;
  /** In-flight — the switch is disabled until the server reconciles. */
  disabled?: boolean;
  onToggle: () => void;
}

export function WatchLiveToggle({
  on,
  name,
  disabled = false,
  onToggle,
}: WatchLiveToggleProps): React.ReactElement {
  const { t } = useTranslation();
  return (
    <span className="tv-chrow__watch">
      <span className="tv-chrow__watch-label" aria-hidden="true">
        {t('channels.row.watchLiveLabel')}
      </span>
      <button
        type="button"
        className="tv-chrow__switch"
        role="switch"
        aria-checked={on}
        aria-label={t(on ? 'channels.row.watchOn' : 'channels.row.watchOff', { name })}
        disabled={disabled}
        onClick={onToggle}
      >
        <span className="tv-chrow__track" data-on={on}>
          <span className="tv-chrow__knob" />
        </span>
      </button>
    </span>
  );
}
