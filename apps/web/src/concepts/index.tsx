// Маршруты прототипов главной страницы: #/concepts (выбор) и #/concepts/a|b|c. Рабочее приложение и его маршруты
// не меняются — прототипы рисуются вместо оболочки только на своих адресах.

import '@fontsource-variable/source-serif-4/opsz.css';
import '@fontsource-variable/source-serif-4/opsz-italic.css';
import { useEffect, type CSSProperties } from 'react';
import { LoginDialog, Notices } from '../components/ui';
import { useI18n } from '../i18n';
import { conceptHash, CONCEPT_IDS, type ConceptId, type ConceptView } from '../lib/cinema';
import { EditorialWater } from './EditorialWater';
import { HydroFuture } from './HydroFuture';
import { RiverNoir } from './RiverNoir';
import { QMark, StillProvider, useStill } from './shared';
import './concepts.css';

export const CONCEPT_NAMES: Record<ConceptId, string> = { a: 'River Noir', b: 'Hydro Future', c: 'Editorial Water' };

export function ConceptsApp({ route }: { route: ConceptView }) {
  const { t } = useI18n();
  useEffect(() => {
    document.title = route.view === 'gallery' ? `QORGAN — ${t('cine.proto.title')}` : `QORGAN — ${CONCEPT_NAMES[route.id]}`;
    window.scrollTo({ top: 0 });
  }, [route, t]);

  return (
    <StillProvider>
      <StillRoot>
        {route.view === 'gallery' ? (
          <Gallery />
        ) : (
          <>
            {route.id === 'a' && <RiverNoir />}
            {route.id === 'b' && <HydroFuture />}
            {route.id === 'c' && <EditorialWater />}
            <ProtoBar current={route.id} />
          </>
        )}
        <LoginDialog />
        <Notices />
      </StillRoot>
    </StillProvider>
  );
}

function StillRoot({ children }: { children: React.ReactNode }) {
  const { still } = useStill();
  return (
    <div className="cine" data-still={still ? 'true' : undefined}>
      {children}
    </div>
  );
}

/** Панель прототипа: переключение концепций и движения (без анимации — как при prefers-reduced-motion — или с ней). */
function ProtoBar({ current }: { current: ConceptId }) {
  const { t } = useI18n();
  const { still, setChoice } = useStill();
  return (
    <nav className="proto-bar" aria-label={t('cine.proto.bar')}>
      <a className="proto-all" href={conceptHash()}>
        {t('cine.proto.all')}
      </a>
      <span className="proto-sep" aria-hidden="true" />
      {CONCEPT_IDS.map((id) => (
        <a key={id} href={conceptHash(id)} aria-current={id === current ? 'page' : undefined} title={CONCEPT_NAMES[id]}>
          {id.toUpperCase()}
        </a>
      ))}
      <span className="proto-sep" aria-hidden="true" />
      <button type="button" className="proto-motion" onClick={() => setChoice(still ? 'motion' : 'still')}>
        {still ? t('cine.proto.motion') : t('cine.proto.still')}
      </button>
    </nav>
  );
}

function Gallery() {
  const { t } = useI18n();
  return (
    <main className="proto-gallery">
      <header className="proto-head">
        <span className="proto-brand">
          <QMark size={30} /> QORGAN · Eclipse Cinematic
        </span>
        <a className="proto-back" href="#/dashboard">
          {t('cine.proto.back')} →
        </a>
      </header>
      <h1>{t('cine.proto.title')}</h1>
      <p className="proto-lead">{t('cine.proto.lead')}</p>
      <ol className="proto-cards">
        {CONCEPT_IDS.map((id, i) => (
          <li key={id} style={{ '--d': `${120 + i * 90}ms` } as CSSProperties}>
            <a className={`proto-card proto-card-${id}`} href={conceptHash(id)}>
              <span className="proto-art" aria-hidden="true">
                <ProtoArt id={id} />
              </span>
              <span className="proto-meta">
                <span className="proto-id">
                  {t('cine.proto.label')} {id.toUpperCase()}
                </span>
                <span className="proto-name">{CONCEPT_NAMES[id]}</span>
                <span className="proto-text">{t(`cine.proto.${id}.text`)}</span>
                <span className="proto-open">{t('cine.proto.open')} →</span>
              </span>
            </a>
          </li>
        ))}
      </ol>
      <p className="proto-note">{t('top.demoShort')}</p>
    </main>
  );
}

/** Миниатюра настроения концепции — собственная графика, не снимок экрана. */
function ProtoArt({ id }: { id: ConceptId }) {
  if (id === 'a')
    return (
      <svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice">
        <rect width="320" height="180" fill="#04070b" />
        <path d="M-10 160C50 150 70 120 110 118s70 10 100-20 60-60 120-80" fill="none" stroke="#9fd6ff" strokeWidth="10" opacity=".18" />
        <path d="M-10 160C50 150 70 120 110 118s70 10 100-20 60-60 120-80" fill="none" stroke="#e8f4ff" strokeWidth="1.6" />
        <rect y="0" width="320" height="16" fill="#000" />
        <rect y="164" width="320" height="16" fill="#000" />
        <rect x="20" y="58" width="150" height="9" rx="2" fill="#f2f6fa" />
        <rect x="20" y="74" width="110" height="9" rx="2" fill="#f2f6fa" opacity=".55" />
      </svg>
    );
  if (id === 'b')
    return (
      <svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice">
        <rect width="320" height="180" fill="#060b14" />
        {Array.from({ length: 9 }, (_, i) => (
          <path key={i} d={`M${160 - (i - 4) * 8} 60L${160 + (i - 4) * 70} 180`} stroke="#5ee0ff" strokeOpacity=".12" />
        ))}
        {Array.from({ length: 6 }, (_, i) => (
          <path key={`h${i}`} d={`M0 ${64 + i * i * 4.4}H320`} stroke="#5ee0ff" strokeOpacity=".1" />
        ))}
        <path d="M168 60C160 90 200 110 170 140s-30 30 -10 40" fill="none" stroke="#5ee0ff" strokeWidth="3" />
        <path d="M200 100V70M170 140V96" stroke="#e6fbff" strokeWidth="1" />
        <circle cx="200" cy="70" r="3" fill="#e6fbff" />
        <circle cx="170" cy="96" r="3" fill="#ffb547" />
      </svg>
    );
  return (
    <svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice">
      <rect width="320" height="180" fill="#f3efe6" />
      {Array.from({ length: 16 }, (_, i) => (
        <path key={i} d={`M170 ${92 + i * 5}q20 ${-3 + (i % 3)} 40 0t40 0t40 0t40 0`} fill="none" stroke="#14202b" strokeWidth={0.5 + i * 0.05} />
      ))}
      <rect x="18" y="50" width="120" height="16" rx="2" fill="#14202b" />
      <rect x="18" y="76" width="84" height="16" rx="2" fill="#1f4f7a" />
      <rect x="18" y="102" width="104" height="16" rx="2" fill="#14202b" />
      <path d="M18 128H140" stroke="#14202b" strokeWidth=".6" />
    </svg>
  );
}
