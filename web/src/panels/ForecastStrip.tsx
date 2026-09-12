import type { Forecast } from '../lib/types';
import { formatClock } from './time';

const VB_W = 960;
const VB_H = 100;
const PAD_L = 28;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 16;

export function ForecastStrip(p: {
  forecast: Forecast | null;
  loading: boolean;
}): JSX.Element {
  if (p.loading) {
    return (
      <div className="tp-panel tp-forecast-strip">
        <div className="tp-panel-header">
          <span className="tp-panel-title">Forecast</span>
        </div>
        <div className="tp-empty-row">Loading forecast…</div>
      </div>
    );
  }

  if (!p.forecast) {
    return (
      <div className="tp-panel tp-forecast-strip">
        <div className="tp-panel-header">
          <span className="tp-panel-title">Forecast</span>
        </div>
        <div className="tp-empty-row">Forecast unavailable</div>
      </div>
    );
  }

  const hourly = p.forecast.hourly ?? [];
  const n = hourly.length;

  if (n === 0) {
    return (
      <div className="tp-panel tp-forecast-strip">
        <div className="tp-panel-header">
          <span className="tp-panel-title">Forecast</span>
          <span className="tp-panel-sub">{p.forecast.location?.name ?? ''}</span>
        </div>
        <div className="tp-empty-row">No forecast data</div>
      </div>
    );
  }

  const plotW = VB_W - PAD_L - PAD_R;
  const plotH = VB_H - PAD_T - PAD_B;
  const step = n > 1 ? plotW / n : plotW;

  const temps = hourly.map((h) => h.temperature);
  const precs = hourly.map((h) => h.precipitation);
  const minT = Math.min(...temps);
  const maxT = Math.max(...temps);
  const tRange = maxT - minT || 1;
  const maxP = Math.max(...precs, 1);

  const xAt = (i: number) => PAD_L + step * i + step / 2;
  const yTemp = (t: number) => PAD_T + (1 - (t - minT) / tRange) * plotH;
  const barH = (prec: number) => (prec / maxP) * (plotH * 0.55);

  const tempPath = hourly
    .map((h, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yTemp(h.temperature).toFixed(1)}`)
    .join(' ');

  const nowIndex = p.forecast.nowIndex;
  const clampedNowIndex = Math.max(0, Math.min(n - 1, nowIndex));
  const nowX = n > 0 ? xAt(clampedNowIndex) : PAD_L;
  const showNowMarker = nowIndex >= 0 && nowIndex < n;

  const firstIso = hourly[0]?.time;
  const lastIso = hourly[n - 1]?.time;

  return (
    <div className="tp-panel tp-forecast-strip">
      <div className="tp-panel-header">
        <span className="tp-panel-title">Forecast</span>
        <span className="tp-panel-sub">
          {p.forecast.location?.name ?? ''} · {minT.toFixed(0)}°–{maxT.toFixed(0)}°C · max precip{' '}
          {p.forecast.summary?.maxPrecip24h ?? 0}mm
        </span>
      </div>
      <svg
        className="tp-forecast-svg"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="48 hour precipitation and temperature forecast"
      >
        {/* precipitation bars */}
        {hourly.map((h, i) => {
          const bh = barH(h.precipitation);
          const x = PAD_L + step * i + step * 0.12;
          const w = Math.max(step * 0.76, 0.5);
          const y = PAD_T + plotH - bh;
          return (
            <rect
              key={`bar-${i}`}
              x={x}
              y={y}
              width={w}
              height={Math.max(bh, 0)}
              className={h.isPast ? 'tp-forecast-bar-past' : 'tp-forecast-bar-future'}
            />
          );
        })}

        {/* baseline */}
        <line
          x1={PAD_L}
          y1={PAD_T + plotH}
          x2={VB_W - PAD_R}
          y2={PAD_T + plotH}
          className="tp-forecast-baseline"
        />

        {/* temperature polyline */}
        <path d={tempPath} className="tp-forecast-temp-line" fill="none" />

        {/* now marker */}
        {showNowMarker ? (
          <line
            x1={nowX}
            y1={PAD_T - 4}
            x2={nowX}
            y2={PAD_T + plotH + 4}
            className="tp-forecast-now-marker"
          />
        ) : null}
      </svg>
      <div className="tp-forecast-axis">
        <span>{formatClock(firstIso)}</span>
        <span className="tp-forecast-axis-now">now</span>
        <span>{formatClock(lastIso)}</span>
      </div>
    </div>
  );
}
