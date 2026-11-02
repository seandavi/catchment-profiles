// Pure helpers: no DOM, no network, no CDN imports, so `node --test` can load this file.

export const LIVE_DATA = 'https://basemap.cancerdatasci.org/data/';

// Never print a number for a cell the source did not report; print why instead.
export const STATUS_LABELS = {
  reported: 'Reported',
  suppressed_small_count: 'Suppressed (small count)',
  suppressed_reliability: 'Suppressed (unreliable)',
  not_applicable: 'Not applicable',
  not_available: 'Not available',
  missing: 'Not in this release',
};

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? `Unreported (${status})`;
}

export function parseParams(search) {
  const p = new URLSearchParams(search);
  const get = (k) => p.get(k) || null;
  return { center: get('center'), release: get('release'), data: get('data'), map: get('map') };
}

// ?data= wins (development), then ?release= (a dated folder), then latest/.
export function dataBase({ release, data }) {
  if (data) return data.endsWith('/') ? data : `${data}/`;
  if (release) return `${LIVE_DATA}${release.startsWith('v') ? release : `v${release}`}/`;
  return `${LIVE_DATA}latest/`;
}

export function tablePath(manifest, schema, table) {
  return manifest.tables?.find((t) => t.schema === schema && t.table === table)?.path ?? null;
}

export const sqlStr = (s) => `'${String(s).replaceAll("'", "''")}'`;
export const sqlList = (items) => items.map(sqlStr).join(', ');

// Filters on source, source_release, measure_id and geo_id, the sort order of
// measure/observation.parquet, so row groups outside the query are skipped.
// Tract-level queries pass tractCountyFips instead of geoIds (a tract id is 'tract:' + 5-digit county FIPS + tract).
export function observationSql(url, { source, release, measureIds, strata, geoIds, tractCountyFips, withCounts }) {
  const where = [
    `source = ${sqlStr(source)}`,
    `source_release = ${sqlStr(release)}`,
    `measure_id IN (${sqlList(measureIds)})`,
  ];
  if (strata?.length) where.push(`stratum_id IN (${sqlList(strata)})`);
  if (tractCountyFips) {
    // The BETWEEN lets Parquet min/max statistics skip row groups; the substr keeps only this catchment's counties.
    const sorted = [...tractCountyFips].sort();
    where.push(`geo_id BETWEEN 'tract:${sorted[0]}' AND 'tract:${sorted.at(-1)}~'`,
      `substr(geo_id, 7, 5) IN (${sqlList(tractCountyFips)})`);
  }
  else where.push(`geo_id IN (${sqlList(geoIds)})`);
  // Only the columns shown: lower/upper are a third of the file and unused; numerator/denominator only pool percentages.
  const columns = ['measure_id', 'stratum_id', 'geo_id', 'period_start', 'period_end', 'value', 'value_status',
    ...(withCounts ? ['numerator', 'denominator'] : [])];
  return `SELECT ${columns.join(', ')}
FROM read_parquet(${sqlStr(url)})
WHERE ${where.join('\n  AND ')}`;
}

export const countyFips = (geoId) => geoId.slice('county:'.length);
export const stateGeoId = (countyGeoId) => `state:${countyFips(countyGeoId).slice(0, 2)}`;

export function modalValue(items) {
  const counts = new Map();
  for (const x of items) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const isReported = (c) => c.value_status === 'reported' && c.value != null;

// cells: one per unit (county or tract) that has a row; expected: how many units the catchment has.
// agg: 'median' (default), 'sum', or 'pooled' (100 * sum(numerator) / sum(denominator), counts only).
// 'pooled' falls back to the median when any reported cell lacks a numerator or denominator.
export function summarize(cells, agg, expected) {
  const reported = cells.filter(isReported);
  const out = { agg, k: reported.length, n: expected, value: null, min: null, max: null, status: 'missing' };
  if (!reported.length) {
    if (cells.length) out.status = modalValue(cells.map((c) => c.value_status));
    return out;
  }
  const values = reported.map((c) => c.value);
  out.status = 'reported';
  out.min = Math.min(...values);
  out.max = Math.max(...values);
  const poolable = reported.every((c) => c.numerator != null && c.denominator != null);
  if (agg === 'pooled' && poolable) {
    const den = reported.reduce((a, c) => a + c.denominator, 0);
    out.value = den > 0 ? (100 * reported.reduce((a, c) => a + c.numerator, 0)) / den : null;
  } else if (agg === 'sum') {
    out.value = values.reduce((a, b) => a + b, 0);
  } else {
    out.value = median(values);
    out.agg = 'median';
  }
  return out;
}

// digits: fixed decimals (percentages); by default fewer decimals for bigger numbers.
export function formatNumber(v, digits) {
  if (v == null || Number.isNaN(v)) return '';
  const a = Math.abs(v);
  const maximumFractionDigits = digits ?? (a >= 1000 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits, minimumFractionDigits: digits ?? 0 }).format(v);
}

// One row from measure.observation (or a summary) to display text.
export function formatCell(cell) {
  return isReported(cell) ? formatNumber(cell.value) : statusLabel(cell.value_status);
}

export function periodLabel(rows) {
  const periods = [...new Set(rows.map((r) => (r.period_start === r.period_end ? `${r.period_start}` : `${r.period_start}–${r.period_end}`)))];
  return periods.sort().join(', ');
}

export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(headers, rows) {
  return [headers, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}
