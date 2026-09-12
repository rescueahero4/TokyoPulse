import * as Cesium from 'cesium';

/**
 * Historical people-flow heatmap. There is no people-flow data file in this
 * build, so the layer is DECLARED and rendered as unavailable. We do not draw a
 * synthetic heatmap - AGENT-BRIEF rule 5 (honest labelling).
 */
export const PEOPLEFLOW_LABEL = 'People flow (typical pattern)';

export function renderPeopleFlow(ds: Cesium.CustomDataSource, available: boolean): number {
  ds.entities.removeAll();
  ds.show = false;
  if (!available) return 0;
  // A real implementation would render the "typical pattern" grid here.
  return 0;
}
