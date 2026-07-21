/**
 * LiveSectionHeader — the shared eyebrow · title · count · subtitle block above
 * each of S7's three areas. Pure presentation; the count pill is shown only once
 * its area has loaded (a number that isn't a placeholder).
 */
export interface LiveSectionHeaderProps {
  eyebrow: string;
  title: string;
  subtitle: string;
  count?: number;
}

export function LiveSectionHeader({
  eyebrow,
  title,
  subtitle,
  count,
}: LiveSectionHeaderProps): React.ReactElement {
  return (
    <div className="tv-live__shead">
      <span className="tv-live__eyebrow">{eyebrow}</span>
      <div className="tv-live__titlerow">
        <h2 className="tv-live__title">{title}</h2>
        {count !== undefined && <span className="tv-live__count tv-numeric">{count}</span>}
      </div>
      <span className="tv-live__sub">{subtitle}</span>
    </div>
  );
}
