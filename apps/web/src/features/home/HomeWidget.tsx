/**
 * HomeWidget — the shared card chrome every Home widget sits in: a titled section
 * with an optional subtitle, header "→" shortcut links (top-right), and a body
 * slot. It carries NO data logic — each widget owns its own loading/empty/error/
 * data body (spec §8, per-widget independence). WidgetFooterLink is the bottom
 * "Open the library →" style affordance the data state uses.
 */
import { Icon } from '../../ds';
import './HomeWidget.css';

export interface HomeWidgetLink {
  label: string;
  onClick: () => void;
}

export interface HomeWidgetProps {
  title: string;
  subtitle?: string;
  /** Header shortcut links, rendered top-right with a trailing arrow. */
  links?: HomeWidgetLink[];
  /** Reflected to aria-busy while the widget's body is loading. */
  busy?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function HomeWidget({
  title,
  subtitle,
  links,
  busy,
  className,
  children,
}: HomeWidgetProps): React.ReactElement {
  return (
    <section
      className={`tv-hw${className ? ` ${className}` : ''}`}
      aria-busy={busy === true ? true : undefined}
    >
      <div className="tv-hw__head">
        <div className="tv-hw__heading">
          <h2 className="tv-hw__title">{title}</h2>
          {subtitle !== undefined && subtitle !== '' && (
            <span className="tv-hw__subtitle">{subtitle}</span>
          )}
        </div>
        {links !== undefined && links.length > 0 && (
          <div className="tv-hw__links">
            {links.map((link) => (
              <button key={link.label} type="button" className="tv-hw__link" onClick={link.onClick}>
                {link.label}
                <Icon name="arrow-right" size={13} />
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="tv-hw__body">{children}</div>
    </section>
  );
}

/** The bottom "see more" link a widget's data state ends with (→ its full screen). */
export function WidgetFooterLink({ label, onClick }: HomeWidgetLink): React.ReactElement {
  return (
    <button type="button" className="tv-hw__more" onClick={onClick}>
      {label}
      <Icon name="arrow-right" size={13} />
    </button>
  );
}
