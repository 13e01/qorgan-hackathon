// Короткая строка на главной панели: ближайшая ожидаемая угроза по прогнозу по реке и запас времени.

import { useI18n } from '../i18n';
import { useCrossingText, useOutlook } from '../pages/Outlook';
import { useStore } from '../state/store';
import { Icon } from './ui';

export function OutlookStrip() {
  const { t } = useI18n();
  const { stations, user } = useStore();
  const { outlook } = useOutlook();
  const text = useCrossingText();
  if (!user || !outlook) return null;
  // Ближайшее ожидаемое превышение опасного уровня (уже превышенные показывает сводка выше).
  const next = outlook.stations
    .filter((s) => s.danger.status === 'EXPECTED')
    .sort((a, b) => (a.danger.h ?? 1e9) - (b.danger.h ?? 1e9))[0];
  const name = (code: string) => stations.find((s) => s.code === code)?.name ?? code;
  return (
    <a className={`outlook-strip${next ? ' has-threat' : ''}`} href="#/outlook">
      <Icon name="timeline" />
      <span>
        <span className="eyebrow">{t('outlook.strip.label')}</span>
        {next ? (
          <b>{t('outlook.strip.next', { station: name(next.code), when: text(next.danger, next.horizonH) })}</b>
        ) : (
          <b>{t('outlook.strip.none', { h: Math.max(...outlook.stations.map((s) => s.horizonH)) })}</b>
        )}
      </span>
      <Icon name="chevronRight" />
    </a>
  );
}
