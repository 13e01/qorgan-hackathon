// Панель администратора (ТЗ §5.7): станции и пороги, коэффициенты модели, пользователи, состояние источников, журналы.
// Каждая кнопка вызывает настоящий маршрут /api/admin/*; сервер проверяет роль, данные и пишет аудит.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { AdminStation, AdminUser, AuditItem, DeviceLogItem, SourceItem } from '../api/types';
import type { RiskConfig } from '../api/shared';
import { Icon, Segmented } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { dateTime, metersFromCm } from '../lib/format';
import { useStore } from '../state/store';

type Tab = 'stations' | 'users' | 'model' | 'sources' | 'audit';
const TABS: Tab[] = ['stations', 'users', 'model', 'sources', 'audit'];

function useLoad<T>(url: string, deps: unknown[] = []): { data: T | null; reload: () => void; error: string | null } {
  const { describeError } = useStore();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    api
      .get<T>(url)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(describeError(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, nonce, describeError, ...deps]);
  return { data, reload: useCallback(() => setNonce((n) => n + 1), []), error };
}

/** Общая обёртка действий: блокирует кнопку на время запроса, показывает успех или ошибку сервера. */
function useAction() {
  const { reportError, notify } = useStore();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | null> => {
      setBusy(true);
      try {
        const r = await fn();
        if (success) notify('info', success);
        return r;
      } catch (err) {
        reportError(err);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [notify, reportError],
  );
  return { busy, run };
}

const num = (v: string): number | null => (v.trim() === '' ? null : Number(v.replace(',', '.')));

// ── Станции ────────────────────────────────────────────────────────────────────────────────────────────────────
interface StationDraft {
  code: string;
  name: string;
  stationType: string;
  status: string;
  lat: string;
  lon: string;
  upstreamCode: string;
  travelHours: string;
  attenuation: string;
  responseHours: string;
  baseLevelCm: string;
  warning: string;
  danger: string;
}

const emptyDraft: StationDraft = {
  code: '', name: '', stationType: 'hydro', status: 'active', lat: '', lon: '', upstreamCode: '', travelHours: '', attenuation: '1', responseHours: '1', baseLevelCm: '', warning: '', danger: '',
};

function toDraft(s: AdminStation): StationDraft {
  const lvl = s.parameters.find((p) => p.code === 'water_level');
  const str = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
  return {
    code: s.code, name: s.name, stationType: s.stationType, status: s.status, lat: String(s.lat), lon: String(s.lon),
    upstreamCode: s.upstreamCode ?? '', travelHours: str(s.travelHours), attenuation: String(s.attenuation), responseHours: String(s.responseHours),
    baseLevelCm: str(s.baseLevelCm), warning: str(lvl?.warning), danger: str(lvl?.danger),
  };
}

function StationEditor({ station, all, onDone }: { station: AdminStation | null; all: AdminStation[]; onDone: () => void }) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const [d, setD] = useState<StationDraft>(station ? toDraft(station) : emptyDraft);
  const set = (k: keyof StationDraft) => (e: { target: { value: string } }) => setD((x) => ({ ...x, [k]: e.target.value }));

  const { notify } = useStore();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Нечисловое значение не должно молча превратиться в «пусто» (NaN → null в JSON) — сообщаем и не отправляем.
    const numeric: Array<keyof StationDraft> = ['lat', 'lon', 'attenuation', 'responseHours', 'baseLevelCm', 'warning', 'danger', ...(d.upstreamCode ? (['travelHours'] as const) : [])];
    const bad = numeric.filter((k) => d[k].trim() !== '' && !Number.isFinite(Number(d[k].replace(',', '.'))));
    if (bad.length) {
      notify('error', t('admin.invalidNumber'));
      return;
    }
    const fields = {
      name: d.name.trim(),
      stationType: d.stationType,
      status: d.status,
      lat: Number(d.lat.replace(',', '.')),
      lon: Number(d.lon.replace(',', '.')),
      upstreamCode: d.upstreamCode || null,
      travelHours: d.upstreamCode ? num(d.travelHours) : null,
      attenuation: Number(d.attenuation.replace(',', '.')),
      responseHours: Number(d.responseHours),
      baseLevelCm: num(d.baseLevelCm),
    };
    const ok = await run(async () => {
      const saved = station
        ? (await api.patch<{ station: AdminStation }>(`/api/admin/stations/${station.id}`, fields)).station
        : (await api.post<{ station: AdminStation }>('/api/admin/stations', { ...fields, code: d.code.trim().toUpperCase() })).station;
      if (saved.parameters.some((p) => p.code === 'water_level')) {
        const params = saved.parameters.map((p) => (p.code === 'water_level' ? { code: p.code, warning: num(d.warning), danger: num(d.danger) } : { code: p.code, warning: p.warning, danger: p.danger }));
        await api.put(`/api/admin/stations/${saved.id}/parameters`, { parameters: params });
      }
      return saved;
    }, t('admin.saved'));
    if (ok) onDone();
  };

  const field = (k: keyof StationDraft, label: MessageKey, props: Record<string, unknown> = {}) => (
    <label className="field">
      <span>{t(label)}</span>
      <input value={d[k]} onChange={set(k)} {...props} />
    </label>
  );

  return (
    <form className="card admin-form" onSubmit={submit}>
      <div className="card-head">
        <h3>{station ? t('admin.station.edit', { code: station.code }) : t('admin.station.new')}</h3>
        <button type="button" className="icon-btn" onClick={onDone} aria-label={t('common.close')}>
          <Icon name="close" />
        </button>
      </div>
      <div className="form-grid">
        {!station && field('code', 'admin.station.code', { required: true, placeholder: 'QRG-05', pattern: '[A-Za-z0-9][A-Za-z0-9-]{1,15}' })}
        {field('name', 'admin.station.name', { required: true, minLength: 2 })}
        <label className="field">
          <span>{t('admin.station.type')}</span>
          <select value={d.stationType} onChange={set('stationType')}>
            {['hydro', 'meteo', 'combined'].map((v) => (
              <option key={v} value={v}>
                {t(`admin.stype.${v}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('admin.station.status')}</span>
          <select value={d.status} onChange={set('status')}>
            {['active', 'maintenance', 'disabled'].map((v) => (
              <option key={v} value={v}>
                {t(`station.status.${v}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        {field('lat', 'admin.station.lat', { required: true, inputMode: 'decimal' })}
        {field('lon', 'admin.station.lon', { required: true, inputMode: 'decimal' })}
        <label className="field">
          <span>{t('admin.station.upstream')}</span>
          <select value={d.upstreamCode} onChange={set('upstreamCode')}>
            <option value="">{t('station.upstreamNone')}</option>
            {all.filter((s) => s.id !== station?.id).map((s) => (
              <option key={s.code} value={s.code}>
                {s.code} · {s.name}
              </option>
            ))}
          </select>
        </label>
        {field('travelHours', 'admin.station.travel', { inputMode: 'decimal', disabled: !d.upstreamCode, required: !!d.upstreamCode })}
        {field('attenuation', 'admin.station.attenuation', { inputMode: 'decimal' })}
        {field('responseHours', 'admin.station.response', { inputMode: 'numeric' })}
        {field('baseLevelCm', 'admin.station.base', { inputMode: 'decimal' })}
        {d.stationType !== 'meteo' && field('warning', 'admin.station.warning', { inputMode: 'decimal' })}
        {d.stationType !== 'meteo' && field('danger', 'admin.station.danger', { inputMode: 'decimal' })}
      </div>
      <p className="faint note">{t('admin.station.note')}</p>
      <div className="row-actions">
        <button type="button" className="btn ghost" onClick={onDone}>
          {t('auth.cancel')}
        </button>
        <button type="submit" className="btn primary" disabled={busy}>
          {t('admin.save')}
        </button>
      </div>
    </form>
  );
}

function StationsTab() {
  const { t, lang } = useI18n();
  const { reloadStations } = useStore();
  const { busy, run } = useAction();
  const { data, reload, error } = useLoad<{ items: AdminStation[] }>('/api/admin/stations');
  const [editing, setEditing] = useState<AdminStation | 'new' | null>(null);
  const [token, setToken] = useState<{ code: string; token: string } | null>(null);
  const items = data?.items ?? [];

  const done = () => {
    setEditing(null);
    reload();
    void reloadStations();
  };

  return (
    <div className="page-stack">
      {error && <div className="callout danger">{error}</div>}
      {token && (
        <div className="callout warn token-box" role="alert">
          <div>
            <b>{t('admin.token.title', { code: token.code })}</b>
            <p>{t('admin.token.once')}</p>
            <code className="token">{token.token}</code>
          </div>
          <button className="btn sm" onClick={() => setToken(null)}>
            {t('admin.token.hide')}
          </button>
        </div>
      )}
      {editing && <StationEditor station={editing === 'new' ? null : editing} all={items} onDone={done} />}
      <section className="card">
        <div className="card-head">
          <h2>{t('admin.tab.stations')}</h2>
          <button className="btn primary sm" onClick={() => setEditing('new')}>
            <Icon name="plus" />
            {t('admin.station.add')}
          </button>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('stations.col.station')}</th>
                <th>{t('admin.station.status')}</th>
                <th>{t('admin.station.upstream')}</th>
                <th>{t('stations.col.thresholds')}</th>
                <th>{t('admin.station.device')}</th>
                <th aria-label={t('admin.actions')} />
              </tr>
            </thead>
            <tbody>
              {items.map((s) => {
                const lvl = s.parameters.find((p) => p.code === 'water_level');
                return (
                  <tr key={s.id} className={s.status === 'disabled' ? 'is-muted' : ''}>
                    <td>
                      <b>{s.name}</b>
                      <div className="faint num">
                        {s.code} · {t(`admin.stype.${s.stationType}` as MessageKey)}
                      </div>
                    </td>
                    <td>{t(`station.status.${s.status}` as MessageKey)}</td>
                    <td className="num">{s.upstreamCode ? `${s.upstreamCode} · ${s.travelHours} ${t('unit.h')}` : '—'}</td>
                    <td className="num">{lvl ? `${metersFromCm(lvl.warning, lang) ?? '—'} / ${metersFromCm(lvl.danger, lang) ?? '—'} ${t('unit.m')}` : t('admin.noLevel')}</td>
                    <td>{s.hasDeviceToken ? t('admin.token.issued') : t('admin.token.none')}</td>
                    <td className="row-actions">
                      <button className="btn sm ghost" onClick={() => setEditing(s)}>
                        {t('admin.edit')}
                      </button>
                      <button
                        className="btn sm ghost"
                        disabled={busy}
                        title={t('admin.token.issue')}
                        onClick={async () => {
                          if (!window.confirm(t('admin.token.confirm', { code: s.code }))) return;
                          const r = await run(() => api.post<{ stationCode: string; token: string }>(`/api/admin/stations/${s.id}/token`));
                          if (r) {
                            setToken({ code: r.stationCode, token: r.token });
                            reload();
                          }
                        }}
                      >
                        <Icon name="key" />
                        <span className="sr-only">{t('admin.token.issue')}</span>
                      </button>
                      {s.status !== 'disabled' && (
                        <button
                          className="btn sm ghost danger-text"
                          disabled={busy}
                          onClick={async () => {
                            if (!window.confirm(t('admin.station.confirmDisable', { name: s.name }))) return;
                            if (await run(() => api.del(`/api/admin/stations/${s.id}`), t('admin.saved'))) done();
                          }}
                        >
                          {t('admin.disable')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="faint note">{t('admin.station.disableNote')}</p>
      </section>
    </div>
  );
}

// ── Пользователи ───────────────────────────────────────────────────────────────────────────────────────────────
function UsersTab() {
  const { t, lang } = useI18n();
  const { user: me } = useStore();
  const { busy, run } = useAction();
  const { data, reload, error } = useLoad<{ items: AdminUser[] }>('/api/admin/users');
  const [form, setForm] = useState({ username: '', password: '', role: 'operator' });

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post('/api/admin/users', form), t('admin.user.created', { name: form.username }))) {
      setForm({ username: '', password: '', role: 'operator' });
      reload();
    }
  };
  const patch = async (u: AdminUser, body: Record<string, unknown>) => {
    if (await run(() => api.patch(`/api/admin/users/${u.id}`, body), t('admin.saved'))) reload();
  };

  return (
    <div className="page-stack">
      {error && <div className="callout danger">{error}</div>}
      <section className="card">
        <div className="card-head">
          <h2>{t('admin.tab.users')}</h2>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('auth.username')}</th>
                <th>{t('admin.user.role')}</th>
                <th>{t('admin.station.status')}</th>
                <th>{t('admin.user.createdAt')}</th>
                <th aria-label={t('admin.actions')} />
              </tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((u) => (
                <tr key={u.id} className={u.isActive ? '' : 'is-muted'}>
                  <td>
                    <b>{u.username}</b>
                    {u.id === me?.id && <span className="faint"> · {t('admin.user.you')}</span>}
                  </td>
                  <td>
                    <select value={u.role} disabled={busy} onChange={(e) => void patch(u, { role: e.target.value })} aria-label={t('admin.user.role')}>
                      <option value="operator">{t('auth.role.operator')}</option>
                      <option value="admin">{t('auth.role.admin')}</option>
                    </select>
                  </td>
                  <td>{u.isActive ? t('admin.user.active') : t('admin.user.inactive')}</td>
                  <td className="num faint">{dateTime(u.createdAt, lang)}</td>
                  <td className="row-actions">
                    <button className="btn sm ghost" disabled={busy || u.id === me?.id} onClick={() => void patch(u, { isActive: !u.isActive })}>
                      {u.isActive ? t('admin.disable') : t('admin.enable')}
                    </button>
                    <button
                      className="btn sm ghost"
                      disabled={busy}
                      onClick={() => {
                        const pw = window.prompt(t('admin.user.newPassword'));
                        if (pw) void patch(u, { password: pw });
                      }}
                    >
                      {t('admin.user.resetPassword')}
                    </button>
                    <button
                      className="btn sm ghost danger-text"
                      disabled={busy || u.id === me?.id}
                      onClick={async () => {
                        if (!window.confirm(t('admin.user.confirmDelete', { name: u.username }))) return;
                        if (await run(() => api.del(`/api/admin/users/${u.id}`), t('admin.saved'))) reload();
                      }}
                    >
                      {t('admin.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <form className="card admin-form" onSubmit={create}>
        <h3>{t('admin.user.new')}</h3>
        <div className="form-grid">
          <label className="field">
            <span>{t('auth.username')}</span>
            <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required pattern="[a-zA-Z0-9._\-]{3,32}" autoComplete="off" />
          </label>
          <label className="field">
            <span>{t('auth.password')}</span>
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={10} autoComplete="new-password" />
          </label>
          <label className="field">
            <span>{t('admin.user.role')}</span>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="operator">{t('auth.role.operator')}</option>
              <option value="admin">{t('auth.role.admin')}</option>
            </select>
          </label>
        </div>
        <p className="faint note">{t('admin.user.note')}</p>
        <div className="row-actions">
          <button type="submit" className="btn primary" disabled={busy}>
            <Icon name="plus" />
            {t('admin.user.add')}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Коэффициенты модели ────────────────────────────────────────────────────────────────────────────────────────
const MODEL_FIELDS: Array<{ path: string; key: MessageKey }> = [
  { path: 'windowSize', key: 'admin.model.windowSize' },
  { path: 'epsilonCmH', key: 'admin.model.epsilonCmH' },
  { path: 'highEtaH', key: 'admin.model.highEtaH' },
  { path: 'mediumEtaH', key: 'admin.model.mediumEtaH' },
  { path: 'rainModerateMm', key: 'admin.model.rainModerateMm' },
  { path: 'rainHeavyMm', key: 'admin.model.rainHeavyMm' },
  { path: 'meltTempC', key: 'admin.model.meltTempC' },
  { path: 'upstreamHorizonH', key: 'admin.model.upstreamHorizonH' },
  { path: 'clearAfterLowCount', key: 'admin.model.clearAfterLowCount' },
  { path: 'categories.mediumScore', key: 'admin.model.mediumScore' },
  { path: 'categories.highScore', key: 'admin.model.highScore' },
];

const getPath = (o: unknown, path: string): number => path.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown>)?.[k], o) as number;

function ModelTab() {
  const { t, lang } = useI18n();
  const { notify } = useStore();
  const { busy, run } = useAction();
  const { data, reload, error } = useLoad<{ config: RiskConfig; defaults: RiskConfig; version: number; updatedAt: string }>('/api/admin/risk-config');
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (data) setValues(Object.fromEntries(MODEL_FIELDS.map((f) => [f.path, String(getPath(data.config, f.path))])));
  }, [data]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    for (const f of MODEL_FIELDS) {
      const raw = String(values[f.path] ?? '').trim();
      const v = Number(raw.replace(',', '.'));
      if (raw === '' || !Number.isFinite(v)) {
        notify('error', t('admin.invalidNumber'));
        return;
      }
      // Отправляем только изменённые значения — сохранение без изменений не создаёт новую версию модели.
      if (data && v === getPath(data.config, f.path)) continue;
      const [a, b] = f.path.split('.');
      if (b) body[a!] = { ...((body[a!] as object) ?? {}), [b]: v };
      else body[a!] = v;
    }
    if (Object.keys(body).length === 0) {
      notify('info', t('admin.model.noChanges'));
      return;
    }
    if (await run(() => api.put('/api/admin/risk-config', body), t('admin.model.saved'))) reload();
  };

  return (
    <form className="card admin-form" onSubmit={save}>
      <div className="card-head">
        <div>
          <h2>{t('admin.tab.model')}</h2>
          {data && <p className="faint num">{t('admin.model.version', { v: data.version, time: dateTime(data.updatedAt, lang) })}</p>}
        </div>
      </div>
      {error && <div className="callout danger">{error}</div>}
      <p className="muted">{t('admin.model.hint')}</p>
      <div className="form-grid">
        {MODEL_FIELDS.map((f) => (
          <label className="field" key={f.path}>
            <span>{t(f.key)}</span>
            <input value={values[f.path] ?? ''} inputMode="decimal" onChange={(e) => setValues((v) => ({ ...v, [f.path]: e.target.value }))} />
            {data && <small className="faint">{t('admin.model.default', { v: getPath(data.defaults, f.path) })}</small>}
          </label>
        ))}
      </div>
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={busy || !data}>
          {t('admin.save')}
        </button>
      </div>
    </form>
  );
}

// ── Источники данных и журналы ─────────────────────────────────────────────────────────────────────────────────
function SourcesTab() {
  const { t, lang } = useI18n();
  const { live } = useStore();
  const { busy, run } = useAction();
  const tick = live.snapshot?.context.virtualTime;
  const sources = useLoad<{ items: SourceItem[]; runStatus: string | null }>('/api/admin/sources', [tick]);
  const log = useLoad<{ items: DeviceLogItem[] }>('/api/admin/device-log?limit=50', [tick]);
  return (
    <div className="page-stack">
      <section className="card">
        <div className="card-head">
          <h2>{t('admin.tab.sources')}</h2>
          <button className="btn sm" disabled={busy} onClick={async () => {
            const r = await run(() => api.post<{ file: string }>('/api/admin/backup'));
            if (r) window.alert(t('admin.backup.done', { file: r.file }));
          }}>
            {t('admin.backup')}
          </button>
        </div>
        <p className="muted">{t('admin.sources.hint')}</p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('stations.col.station')}</th>
                <th>{t('admin.sources.link')}</th>
                <th>{t('admin.sources.last')}</th>
                <th>{t('admin.sources.rejected')}</th>
                <th>{t('admin.sources.flagged')}</th>
              </tr>
            </thead>
            <tbody>
              {(sources.data?.items ?? []).map((s) => (
                <tr key={s.id}>
                  <td>
                    <b>{s.name}</b> <span className="faint num">{s.code}</span>
                  </td>
                  <td>
                    <span className={`chip link-${s.link}`}>{t(`admin.link.${s.link}` as MessageKey)}</span>
                  </td>
                  <td className="num faint">{s.lastMessageAt ? dateTime(s.lastMessageAt, lang) : '—'}</td>
                  <td className="num">{s.rejected24h}</td>
                  <td className="num">{s.flaggedInRun}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h2>{t('admin.log.title')}</h2>
        </div>
        {(log.data?.items.length ?? 0) === 0 ? (
          <p className="muted">{t('admin.log.empty')}</p>
        ) : (
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>{t('admin.log.time')}</th>
                  <th>{t('admin.log.code')}</th>
                  <th>{t('stations.col.station')}</th>
                  <th>{t('admin.log.details')}</th>
                </tr>
              </thead>
              <tbody>
                {log.data!.items.map((l) => (
                  <tr key={l.id}>
                    <td className="num faint">{dateTime(l.createdAt, lang)}</td>
                    <td>
                      <span className={`chip lvl-${l.level}`}>{l.code}</span>
                    </td>
                    <td className="num">{l.stationCode ?? '—'}</td>
                    <td className="faint mono-sm">{JSON.stringify(l.details).slice(0, 140)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function AuditTab() {
  const { t, lang } = useI18n();
  const { data } = useLoad<{ items: AuditItem[] }>('/api/admin/audit?limit=100');
  return (
    <section className="card">
      <div className="card-head">
        <h2>{t('admin.tab.audit')}</h2>
      </div>
      <p className="muted">{t('admin.audit.hint')}</p>
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th>{t('admin.log.time')}</th>
              <th>{t('admin.audit.user')}</th>
              <th>{t('admin.audit.action')}</th>
              <th>{t('admin.audit.entity')}</th>
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((a) => (
              <tr key={a.id}>
                <td className="num faint">{dateTime(a.createdAt, lang)}</td>
                <td>{a.user ?? t('admin.audit.system')}</td>
                <td>
                  <span className="chip">{a.action}</span>
                </td>
                <td className="num">
                  {a.entity}
                  {a.entityId ? ` #${a.entityId}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Admin() {
  const { t } = useI18n();
  const { user, authReady, setLoginOpen } = useStore();
  const [tab, setTab] = useState<Tab>('stations');
  if (!authReady) return <p className="muted">{t('common.loading')}</p>;
  if (user?.role !== 'admin') {
    return (
      <div className="card empty">
        <p>
          <b>{t('admin.denied')}</b>
        </p>
        {!user && (
          <button className="btn primary" onClick={() => setLoginOpen(true)}>
            {t('auth.login')}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="page-stack">
      <Segmented
        className="tabs"
        label={t('nav.admin')}
        value={tab}
        onChange={setTab}
        options={TABS.map((x) => ({ value: x, content: t(`admin.tab.${x}` as MessageKey), title: t(`admin.tab.${x}` as MessageKey) }))}
      />
      {tab === 'stations' && <StationsTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'model' && <ModelTab />}
      {tab === 'sources' && <SourcesTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}
