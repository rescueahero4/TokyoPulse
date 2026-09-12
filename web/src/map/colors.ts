import * as Cesium from 'cesium';
import type { LineStatus, Severity } from '../lib/types';

/** Palette is frozen by contracts/ui-contract.md rule 5. */
export const STATUS_HEX: Record<LineStatus, string> = {
  normal: '#22c55e',
  delay: '#f59e0b',
  suspended: '#ef4444',
  unknown: '#6b7280',
};

export const SEVERITY_HEX: Record<Severity, string> = {
  info: '#38bdf8',
  warning: '#f59e0b',
  critical: '#ef4444',
};

const cache = new Map<string, Cesium.Color>();

export function css(hex: string): Cesium.Color {
  const key = hex.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  let c: Cesium.Color;
  try {
    c = Cesium.Color.fromCssColorString(hex) ?? Cesium.Color.GRAY;
  } catch {
    c = Cesium.Color.GRAY;
  }
  cache.set(key, c);
  return c;
}

export function statusColor(status: LineStatus | string | null | undefined): Cesium.Color {
  const key = (status || 'unknown') as LineStatus;
  return css(STATUS_HEX[key] ?? STATUS_HEX.unknown);
}

export function severityColor(sev: Severity | string | null | undefined): Cesium.Color {
  const key = (sev || 'info') as Severity;
  return css(SEVERITY_HEX[key] ?? SEVERITY_HEX.info);
}
