// Лента активных предупреждений на главной панели — из снимка WebSocket (видит и гость: это опубликованные предупреждения).

import { useI18n } from '../i18n';
import { useStore } from '../state/store';
import { AlertCard } from './AlertItem';
import { Icon } from './ui';

export function AlertFeed() {
  const { t } = useI18n();
  const { live } = useStore();
  const a = live.snapshot?.alerts;
  const active = a?.active ?? [];
  return (
    <section className="card alert-feed" aria-live="polite">
      <div className="card-head">
        <h2>
          <Icon name="bell" />
          {t('alerts.feed')}
          {active.length > 0 && <span className="count-pill num">{active.length}</span>}
        </h2>
        <a className="btn ghost sm" href="#/alerts">
          {t('alerts.toJournal')}
          <Icon name="chevronRight" />
        </a>
      </div>
      {active.length === 0 ? (
        <p className="muted">{t('alerts.emptyActive')}</p>
      ) : (
        <div className="alert-list">
          {active.slice(0, 3).map((x) => (
            <AlertCard key={x.id} alert={x} compact />
          ))}
          {active.length > 3 && <p className="faint">{t('alerts.more', { n: active.length - 3 })}</p>}
        </div>
      )}
    </section>
  );
}
