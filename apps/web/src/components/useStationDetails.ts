// Подробности выбранной станции: объяснение оценки (всем) и прогноз (оператору).
// Запрашиваются при выборе станции и при новых данных, но не чаще раза в 800 мс — без бесконечного опроса.

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { ExplanationResponse, ForecastResponse } from '../api/types';
import { useStore } from '../state/store';

const MIN_INTERVAL_MS = 800;

export function useStationDetails(code: string) {
  const { live, user } = useStore();
  const [explanation, setExplanation] = useState<ExplanationResponse | null>(null);
  const [forecast, setForecast] = useState<ForecastResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dataKey = `${live.key?.runId}:${live.key?.t}:${live.snapshot?.simulation.state}`;

  useEffect(() => {
    setExplanation(null);
    setForecast(null);
    last.current = 0;
  }, [code, user?.id]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      last.current = Date.now();
      try {
        const [exp, fc] = await Promise.all([
          api.get<ExplanationResponse>(`/api/stations/${code}/risk/explanation`),
          user ? api.get<ForecastResponse>(`/api/stations/${code}/forecast`) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setExplanation(exp);
        setForecast(fc);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err : new ApiError(0, 'NETWORK', String(err)));
      }
    };
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - last.current));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), wait);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [code, user, dataKey]);

  return { explanation, forecast, error };
}
