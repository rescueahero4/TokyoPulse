// Local time-formatting helper for panels. Deliberately not in web/src/lib/ (A1a owns lib/).
// All timestamps are ISO8601 with explicit offset (Asia/Tokyo, +09:00) per AGENT-BRIEF.

/** "14:32" in Asia/Tokyo, regardless of the viewer's machine timezone. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  try {
    return d.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Tokyo',
    });
  } catch {
    return '--:--';
  }
}

/** "3m ago" / "2h ago" / "just now" / "in 5m" for future timestamps. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (Math.abs(diffMin) < 1) return 'just now';
  if (diffMin > 0) {
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.round(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.round(diffH / 24);
    return `${diffD}d ago`;
  }
  const futureMin = -diffMin;
  if (futureMin < 60) return `in ${futureMin}m`;
  const futureH = Math.round(futureMin / 60);
  return `in ${futureH}h`;
}

/** "14:32 · 3m ago" compact form used by Timeline rows. */
export function formatClockWithRelative(iso: string | null | undefined): string {
  const clock = formatClock(iso);
  const rel = formatRelative(iso);
  return rel ? `${clock} · ${rel}` : clock;
}
