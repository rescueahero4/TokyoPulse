// The bottom strip used to be labelled "FORECAST". That was wrong and the human
// could not tell what it showed: the payload is ~96 hourly points of which most
// are HISTORY (isPast), and it carries TWO series — temperature (line) and
// precipitation (bars). It is now labelled "Weather", states its real span
// (computed from the data, not assumed), names both series in a legend, and
// prints a °C axis on the left and a mm axis on the right.
//
// Exported name and props are unchanged (ui-contract is frozen).

import type { ReactNode } from 'react';
import type { Forecast } from '../lib/types';
import { formatDayClock } from './time';
import { PanelHeader } from './PanelHeader';
import { useCollapse } from './useCollapse';

const VB_W = 960;
const VB_H = 100;
const PAD_L = 6;
const PAD_R = 6;
const PAD_T = 8;
const PAD_B = 8;

function Legend(): JSX.Element {
  return (
    <div className="tp-wx-legend">
      <span className="tp-wx-legend-item">
        <svg className="tp-wx-swatch" viewBox="0 0 18 8" aria-hidden="true">
          <path d="M0 6 L5 2 L10 5 L18 1" className="tp-forecast-temp-line" fill="none" />
        </svg>
        Temperature <span className="tp-wx-unit">°C</span>
      </span>
      <span className="tp-wx-legend-item">
        <svg className="tp-wx-swatch" viewBox="0 0 18 8" aria-hidden="true">
          <rect x="1" y="3" width="3" height="5" className="tp-forecast-bar-past" />
          <rect x="6" y="1" width="3" height="7" className="tp-forecast-bar-future" />
          <rect x="11" y="4" width="3" height="4" className="tp-forecast-bar-future" />
        </svg>
        Rain <span className="tp-wx-unit">mm/h</span>
      </span>
      <span className="tp-wx-legend-item tp-wx-legend-now">
        <svg className="tp-wx-swatch" viewBox="0 0 18 8" aria-hidden="true">
          <line x1="9" y1="0" x2="9" y2="8" className="tp-forecast-now-marker" />
        </svg>
        Now
      </span>
    </div>
  );
}

function Shell(p: { collapsed: boolean; onToggle(): void; sub: string; children: ReactNode }) {
  return (
    <div className={`tp-panel tp-forecast-strip${p.collapsed ? ' tp-panel-collapsed' : ''}`}>
      <PanelHeader
        title="Weather"
        sub={p.sub}
        label="Weather"
        collapsed={p.collapsed}
        onToggleCollapse={p.onToggle}
      />
      {p.collapsed ? null : p.children}
    </div>
  );
}

export function ForecastStrip(p: {
  forecast: Forecast | null;
  loading: boolean;
}): JSX.Element {
  const [collapsed, toggleCollapsed] = useCollapse('weather');

  const hourly = p.forecast?.hourly ?? [];
  const n = hourly.length;

  if (n === 0) {
    const sub = p.loading ? 'loading…' : 'temp + rain · no data';
    return (
      <Shell collapsed={collapsed} onToggle={toggleCollapsed} sub={sub}>
        <div className="tp-empty-row">
          {p.loading ? 'Loading weather…' : !p.forecast ? 'Weather unavailable' : 'No weather data'}
        </div>
      </Shell>
    );
  }

  const forecast = p.forecast!;
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

  const nowIndex = forecast.nowIndex;
  const clampedNowIndex = Math.max(0, Math.min(n - 1, nowIndex));
  const nowX = xAt(clampedNowIndex);
  const showNowMarker = nowIndex >= 0 && nowIndex < n;
  const nowPct = (nowX / VB_W) * 100;

  // Honest span, computed from the payload — NOT assumed. Most of this strip is
  // history, which is exactly what "FORECAST" hid.
  const pastHours = hourly.reduce((acc, h) => acc + (h.isPast ? 1 : 0), 0);
  const futureHours = n - pastHours;
  const place = forecast.location?.name ?? 'Tokyo';
  const sub = `${place} · temp + rain · past ${pastHours}h → next ${futureHours}h`;

  return (
    <Shell collapsed={collapsed} onToggle={toggleCollapsed} sub={sub}>
      <Legend />
      <div className="tp-wx-plot">
        <svg
          className="tp-forecast-svg"
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Tokyo temperature and precipitation, past ${pastHours} hours and next ${futureHours} hours`}
        >
          {/* precipitation bars (mm, right axis) */}
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

          {/* temperature polyline (°C, left axis) */}
          <path d={tempPath} className="tp-forecast-temp-line" fill="none" />

          {/* now marker */}
          {showNowMarker ? (
            <line x1={nowX} y1={0} x2={nowX} y2={VB_H} className="tp-forecast-now-marker" />
          ) : null}
        </svg>

        {/* Axis hints as HTML, not SVG text: the plot uses
            preserveAspectRatio="none", which would stretch any <text>. */}
        <span className="tp-wx-axis tp-wx-axis-left tp-wx-axis-top">{maxT.toFixed(0)}°C</span>
        <span className="tp-wx-axis tp-wx-axis-left tp-wx-axis-bottom">{minT.toFixed(0)}°C</span>
        <span className="tp-wx-axis tp-wx-axis-right tp-wx-axis-top">{maxP.toFixed(1)}mm</span>
        <span className="tp-wx-axis tp-wx-axis-right tp-wx-axis-bottom">0mm</span>
        {showNowMarker ? (
          <span className="tp-wx-now-label" style={{ left: `${nowPct}%` }}>
            NOW
          </span>
        ) : null}
      </div>
      <div className="tp-forecast-axis">
        <span>{formatDayClock(hourly[0]?.time)}</span>
        <span className="tp-forecast-axis-mid">
          {forecast.summary
            ? `max rain 24h ${forecast.summary.maxPrecip24h}mm · ${forecast.summary.rainHoursNext48}h rain next 48h`
            : ''}
        </span>
        <span>{formatDayClock(hourly[n - 1]?.time)}</span>
      </div>
    </Shell>
  );
}
