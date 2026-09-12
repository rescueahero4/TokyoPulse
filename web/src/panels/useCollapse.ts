// Per-panel collapsed state, persisted so the presenter's HUD layout survives a
// reload mid-demo. localStorage can THROW (private window / blocked site data),
// so every read and write is wrapped — a storage failure must degrade to
// "remember nothing", never to a blank HUD.

import { useCallback, useState } from 'react';

const PREFIX = 'tp.collapsed.';

function read(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    /* private window, blocked storage, quota — keep the default */
  }
  return fallback;
}

function write(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(PREFIX + key, value ? '1' : '0');
  } catch {
    /* non-fatal: the panel still collapses for this session */
  }
}

/**
 * `const [collapsed, toggle] = useCollapse('timeline')`
 * Lazily initialised from localStorage; every change is written back.
 */
export function useCollapse(key: string, defaultCollapsed = false) {
  const [collapsed, setCollapsed] = useState<boolean>(() => read(key, defaultCollapsed));

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      write(key, next);
      return next;
    });
  }, [key]);

  return [collapsed, toggle] as const;
}
