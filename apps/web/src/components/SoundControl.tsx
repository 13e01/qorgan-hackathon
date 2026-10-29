// Кнопка звука в верхней строке: включить/выключить, громкость, проверка двух сигналов.
// Настройка хранится в браузере. Звук — дополнение к текстовым уведомлениям, не замена.

import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useSound } from '../state/sound';
import { Icon } from './ui';

export function SoundControl() {
  const { t } = useI18n();
  const sound = useSound();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const volumeId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onRoute = () => setOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('hashchange', onRoute);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('hashchange', onRoute);
    };
  }, [open]);

  const on = sound.prefs.enabled;
  const label = on ? t('sound.on') : t('sound.off');
  return (
    <div className="sound-ctl" ref={box}>
      <button
        className={`icon-btn sound-btn${on ? ' is-on' : ''}${sound.locked ? ' is-locked' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${t('sound.title')}: ${label}`}
        title={`${t('sound.title')}: ${label}`}
      >
        <Icon name={on ? 'sound' : 'soundOff'} />
      </button>
      {open && (
        <div className="sound-pop" id={panelId} role="dialog" aria-label={t('sound.title')}>
          <label className="switch-row">
            <input type="checkbox" role="switch" checked={on} disabled={!sound.supported} onChange={(e) => void sound.setEnabled(e.target.checked)} />
            <span>
              <b>{t('sound.title')}</b>
              <span className="faint">{t('sound.hint')}</span>
            </span>
          </label>
          <div className="sound-volume">
            <label htmlFor={volumeId}>{t('sound.volume')}</label>
            <input
              id={volumeId}
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(sound.prefs.volume * 100)}
              onChange={(e) => sound.setVolume(Number(e.target.value) / 100)}
              aria-valuetext={`${Math.round(sound.prefs.volume * 100)} %`}
            />
            <span className="num faint">{Math.round(sound.prefs.volume * 100)} %</span>
          </div>
          <div className="sound-test">
            <span className="faint">{t('sound.test')}</span>
            <button className="btn sm" onClick={() => void sound.test('MEDIUM')}>
              {t('risk.MEDIUM')}
            </button>
            <button className="btn sm" onClick={() => void sound.test('HIGH')}>
              {t('risk.HIGH')}
            </button>
          </div>
          {!sound.supported && <p className="callout warn">{t('sound.unsupported')}</p>}
          {sound.locked && <p className="callout info">{t('sound.locked')}</p>}
          <p className="faint note">{t('sound.note')}</p>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {sound.lastPlayed ? t('sound.played', { risk: t(`risk.${sound.lastPlayed.kind}`) }) : ''}
      </span>
    </div>
  );
}
