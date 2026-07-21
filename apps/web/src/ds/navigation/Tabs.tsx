/**
 * Tabs — underline style with optional count pills (queue status tabs, settings
 * sections). Real tab semantics (role=tab + aria-selected) for keyboard/a11y.
 */
import './Tabs.css';

export interface TabItem {
  value: string;
  label: string;
  count?: number;
}

export interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function Tabs({ tabs, value, onChange, className }: TabsProps): React.ReactElement {
  return (
    <div className={`tv-tabs${className ? ` ${className}` : ''}`} role="tablist">
      {tabs.map((tab) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            className={`tv-tab${active ? ' tv-tab--active' : ''}`}
            onClick={() => onChange(tab.value)}
          >
            <span className="tv-tab__label">{tab.label}</span>
            {tab.count !== undefined && (
              <span className="tv-tab__count tv-numeric">{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
