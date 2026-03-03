/**
 * ATLAS Health & Metrics (ATLAS-14)
 * GET /api/health — returns structured health status for monitoring.
 */

export function buildHealthReport(atlas, runner, startTime) {
  const uptime = Math.round((Date.now() - startTime) / 1000);
  const sync   = atlas.getSyncStatus();
  const connectors = runner.getStats();

  // Connector health: degraded if last_run is null or >2x the interval
  const connectorHealth = connectors.map(c => {
    let status = 'ok';
    if (!c.last_run) {
      status = c.runs === 0 ? 'starting' : 'error';
    } else {
      const ageMs  = Date.now() - new Date(c.last_run).getTime();
      const maxMs  = (c.interval_minutes ?? 30) * 2 * 60_000;
      if (ageMs > maxMs) status = 'stale';
    }
    return { ...c, health: status };
  });

  const degraded = connectorHealth.filter(c => ['error','stale'].includes(c.health));
  const overall  = degraded.length ? 'degraded' : 'healthy';

  // Record counts
  const counts = {};
  for (const [table, info] of Object.entries(sync)) {
    counts[table] = info.count ?? 0;
  }

  return {
    status: overall,
    version: '1.0.0',
    uptime_seconds: uptime,
    started_at: new Date(startTime).toISOString(),
    checked_at: new Date().toISOString(),
    storage: counts,
    connectors: connectorHealth,
    degraded_connectors: degraded.length,
    alerts: degraded.length
      ? degraded.map(c => `Connector "${c.id}" is ${c.health}`)
      : [],
  };
}
