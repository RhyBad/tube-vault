/**
 * SortControl — a compact sort dropdown (the video listings' 4 sorts). A native
 * <select> with a leading sort glyph, labelled for a11y.
 */
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import '../forms/field.css';
import { Icon } from '../icon/Icon';
import './SortControl.css';

export interface SortOption {
  value: string;
  label: string;
}

export interface SortControlProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<string | SortOption>;
  disabled?: boolean;
  className?: string;
}

export function SortControl({
  value,
  onChange,
  options,
  disabled = false,
  className,
}: SortControlProps): React.ReactElement {
  const { t } = useTranslation();
  const id = useId();
  const normalized: SortOption[] = options.map((o) =>
    typeof o === 'string' ? { value: o, label: o } : o,
  );

  return (
    <div className={`tv-field__control tv-sort${className ? ` ${className}` : ''}`}>
      <Icon name="sort" size={15} className="tv-field__icon" />
      <select
        id={id}
        className="tv-input tv-input--with-icon tv-sort__select"
        aria-label={t('toolbar.sortBy')}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {normalized.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevron-down" size={16} className="tv-select__chevron" />
    </div>
  );
}
