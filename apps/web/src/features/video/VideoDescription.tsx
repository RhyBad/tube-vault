/**
 * VideoDescription — the video's long-form description (EP-16, CR-14). It is
 * null for flat channel-enumeration candidates (only add-url captures it), so the
 * whole block is hidden rather than showing an empty shell — the spec's "degrade
 * gracefully" (§3/§10). Whitespace preserved so paragraph breaks survive.
 */
import { useTranslation } from 'react-i18next';

export interface VideoDescriptionProps {
  description: string | null;
}

export function VideoDescription({
  description,
}: VideoDescriptionProps): React.ReactElement | null {
  const { t } = useTranslation();
  if (description === null || description.trim() === '') return null;
  return (
    <section className="tv-video__desc" aria-label={t('video.description.title')}>
      <h2 className="tv-video__section-title">{t('video.description.title')}</h2>
      <p className="tv-video__desc-body">{description}</p>
    </section>
  );
}
