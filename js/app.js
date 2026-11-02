import {
  parseParams, dataBase, customDataHost, httpUrl, observationSql, sqlStr, sqlList, countyFips, stateGeoId, modalValue, median,
  summarize, summarizeTracts, tractCoverage, pickMapKey, formatNumber, formatCell, statusLabel, periodLabel, toCsv,
} from './lib.js';
import { SECTIONS } from './config.js';
import { openDb, tableUrl } from './db.js';
import { loadTopology, catchmentGeometry } from './map.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const secs = (ms) => (ms / 1000).toFixed(1);

const params = parseParams(location.search);
const base = new URL(dataBase(params), document.baseURI).href;

const FACILITY_KINDS = {
  fqhc: 'Federally qualified health center sites',
  mammography: 'Mammography facilities',
  superfund: 'Superfund National Priorities List sites',
};
const AGG_WORDS = { median: 'median', sum: 'sum', pooled: 'pooled' };
const perf = (window.__cp = { base, firstContentMs: null, doneMs: null });

// mapWanted: the measure the URL asked for, or the user's last pick; kept until a section that has it loads.
const ctx = { csv: [], mapModels: new Map(), runId: 0, mapWanted: params.map };

function setStatus(text, isError = false) {
  const el = $('#status');
  el.hidden = !text;
  el.textContent = text ?? '';
  el.className = isError ? 'error' : '';
  el.setAttribute('role', isError ? 'alert' : 'status');
}

// ---------- theme ----------
const root = document.documentElement;
$('#theme').addEventListener('click', () => {
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('cp-theme', root.dataset.theme); } catch { /* private mode */ }
});

// ---------- release / centers ----------
async function init() {
  const customHost = customDataHost(base);
  if (customHost) {
    const banner = $('#data-banner');
    banner.textContent = `Custom data source: ${customHost}`;
    banner.hidden = false;
  }
  setStatus('Loading Cancer Basemap release and DuckDB…');
  const manifestRes = fetch(new URL('manifest.json', base)).then((r) => {
    if (!r.ok) throw new Error(`manifest.json: HTTP ${r.status}`);
    return r.json();
  });
  const [manifest, query] = await Promise.all([manifestRes, openDb()]);
  Object.assign(ctx, { manifest, query });
  perf.query = query; // for headless checks (AGENTS.md)
  ctx.obs = tableUrl(base, manifest, 'measure', 'observation').url;
  const centerT = tableUrl(base, manifest, 'catchment', 'center');
  ctx.memberUrl = tableUrl(base, manifest, 'catchment', 'member').url;
  ctx.bundledCatchment = centerT.bundled;
  ctx.topology = loadTopology();
  ctx.topology.catch(() => {});

  const hf = `seandavis/cancerbasemap@${manifest.release}`;
  $('#release').innerHTML = `Cancer Basemap release <strong>${esc(manifest.release)}</strong>`
    + (ctx.bundledCatchment ? ' <span class="muted">(catchment tables from the bundled copy)</span>' : '');
  $('#cite-text').innerHTML = `<p>Data: Cancer Basemap release ${esc(manifest.release)}
      (<a href="https://basemap.cancerdatasci.org/">basemap.cancerdatasci.org</a>; Hugging Face tag <code>${esc(hf)}</code>;
      <a href="${esc(new URL('manifest.json', base).href)}">manifest</a>).
      Each table names its source, source release and period.</p>
    <p>Catchment areas: NCI Office of Cancer Centers; DelNero et al., <em>Cancer Epidemiol Biomarkers Prev</em> 2022,
      <a href="https://doi.org/10.1158/1055-9965.EPI-21-1230">doi:10.1158/1055-9965.EPI-21-1230</a>.</p>`;

  ctx.defs = new Map((await query(`SELECT measure_id, label, units, rate_basis
    FROM read_parquet(${sqlStr(tableUrl(base, manifest, 'measure', 'definition').url)})`)).map((d) => [d.measure_id, d]));
  const centers = await query(`SELECT center_id, name, state FROM read_parquet(${sqlStr(centerT.url)}) ORDER BY name`);
  $('#center').innerHTML = '<option value="">Choose a cancer center…</option>'
    + centers.map((c) => `<option value="${esc(c.center_id)}">${esc(c.name)}</option>`).join('');
  $('#center').disabled = false;
  $('#center').addEventListener('change', (e) => selectCenter(e.target.value));
  if (params.center && centers.some((c) => c.center_id === params.center)) {
    $('#center').value = params.center;
    await selectCenter(params.center);
  } else {
    setStatus(params.center ? `No center with id ${params.center} in this release.` : 'Choose a cancer center to see its catchment.', !!params.center);
  }
}

// The center's website is linked only when it is an http(s) URL; any other text is shown as is.
function centerLink(url) {
  if (!url) return '';
  const href = httpUrl(url);
  return ` · ${href ? `<a href="${esc(href)}">center website</a>` : `website: ${esc(url)}`}`;
}

// ---------- one center ----------
async function selectCenter(centerId) {
  const run = ++ctx.runId;
  const stale = () => run !== ctx.runId;
  const url = new URL(location.href);
  centerId ? url.searchParams.set('center', centerId) : url.searchParams.delete('center');
  url.searchParams.delete('map');
  history.replaceState(null, '', url);
  $('#profile').hidden = !centerId;
  if (!centerId) return setStatus('Choose a cancer center to see its catchment.');
  ctx.csv = [];
  ctx.mapModels = new Map();
  setStatus('Loading catchment…');
  const t = performance.now();
  const { query } = ctx;

  const members = await query(`SELECT geo_id, overlap_fraction FROM read_parquet(${sqlStr(ctx.memberUrl)})
    WHERE center_id = ${sqlStr(centerId)} AND geo_id LIKE 'county:%' ORDER BY geo_id`);
  if (stale()) return;
  const countyIds = members.map((m) => m.geo_id);
  const stateId = modalValue(countyIds.map(stateGeoId));
  const wanted = [...countyIds, stateId, 'nation:US'];
  const nameMap = new Map((await query(`SELECT geo_id, arg_max(name, vintage) AS name
    FROM read_parquet(${sqlStr(tableUrl(base, ctx.manifest, 'geography', 'unit').url)})
    WHERE geo_id IN (${sqlList(wanted)}) GROUP BY geo_id`)).map((r) => [r.geo_id, r.name]));
  if (stale()) return;
  Object.assign(ctx, { centerId, countyIds, stateId, names: nameMap, overlap: new Map(members.map((m) => [m.geo_id, m.overlap_fraction])) });

  const center = (await query(`SELECT name, designation_type, geo_description, url FROM read_parquet(${sqlStr(tableUrl(base, ctx.manifest, 'catchment', 'center').url)})
    WHERE center_id = ${sqlStr(centerId)}`))[0];
  $('#summary').innerHTML = `<h2>${esc(center.name)}</h2>
    <p>${esc(center.designation_type)} · ${esc(center.geo_description)} catchment · ${countyIds.length} counties,
    mostly in ${esc(nameMap.get(stateId) ?? stateId)}${centerLink(center.url)}</p>`;
  document.title = `${center.name} · Catchment Profiles`;
  setStatus(null);

  $('#sections').innerHTML = SECTIONS.map((s) => `<section id="${s.id}" aria-labelledby="${s.id}-h">
      <h2 id="${s.id}-h">${esc(s.title)}</h2><p class="intro">${esc(s.intro)}</p>
      <div class="body"><p class="muted">Loading…</p></div></section>`).join('')
    + '<section id="facilities" aria-labelledby="facilities-h"><h2 id="facilities-h">Facilities</h2><div class="body"><p class="muted">Loading…</p></div></section>';
  drawMap(run);
  // A profile reads tens of MB of Parquet: burden loads at once, the other sections as they near the viewport.
  ctx.sectionObserver?.disconnect();
  delete document.body.dataset.ready;
  const jobs = new Map([...SECTIONS.map((s) => [s.id, () => renderSection(s, run)]), ['facilities', () => renderFacilities(run)]]);
  const running = new Map();
  const start = (id) => {
    if (running.has(id)) return;
    (perf.started ??= []).push([id, Math.round(performance.now())]);
    running.set(id, jobs.get(id)());
    if (running.size < jobs.size) return;
    Promise.all(running.values()).then(() => {
      if (stale()) return;
      perf.doneMs = performance.now();
      $('#timing').textContent = `All sections loaded ${secs(perf.doneMs - t)} s after the center was chosen (${secs(perf.doneMs)} s since navigation).`;
      document.body.dataset.ready = 'true';
    });
  };
  ctx.sectionObserver = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) start(e.target.id);
  }, { rootMargin: '0px 0px 200px 0px' });
  for (const id of jobs.keys()) ctx.sectionObserver.observe($(`#${id}`));
  start('burden');
}

// ---------- measures ----------
// One query per (source, release, level) in a section, so each Parquet range is fetched once.
async function loadGroups(groups) {
  const { query, countyIds, stateId } = ctx;
  const refIds = { state: stateId, nation: 'nation:US' };
  const buckets = Map.groupBy(groups, (g) => `${g.source}|${g.release}|${g.level}`);
  const rowsByKey = new Map(await Promise.all([...buckets].map(async ([key, gs]) => {
    const measures = gs.flatMap((g) => g.measures);
    const isTract = gs[0].level === 'tract';
    const rows = await query(observationSql(ctx.obs, {
      source: gs[0].source,
      release: gs[0].release,
      measureIds: [...new Set(measures.map((m) => m.id))],
      strata: measures.every((m) => m.stratum) ? [...new Set(measures.map((m) => m.stratum))] : null,
      geoIds: isTract ? null : [...countyIds, ...new Set(gs.flatMap((g) => g.reference.map((r) => refIds[r])))],
      tractCountyFips: isTract ? countyIds.map(countyFips) : null,
      withCounts: gs.some((g) => g.measures.some((m) => (m.agg ?? g.agg) === 'pooled')),
    }));
    return [key, rows];
  })));
  return groups.map((g) => modelsFor(g, rowsByKey.get(`${g.source}|${g.release}|${g.level}`), refIds));
}

function modelsFor(g, rows, refIds) {
  const { countyIds } = ctx;
  const isTract = g.level === 'tract';
  const unitWord = isTract ? 'tracts' : 'counties';
  return g.measures.map((m) => {
    const mine = rows.filter((r) => r.measure_id === m.id && (!m.stratum || r.stratum_id === m.stratum));
    const cells = mine.filter((r) => (isTract ? r.geo_id.startsWith('tract:') : r.geo_id.startsWith('county:')));
    const def = ctx.defs.get(m.id);
    const byCounty = new Map();
    if (isTract) {
      for (const [fips, list] of Map.groupBy(cells, (r) => r.geo_id.slice(6, 11))) {
        byCounty.set(fips, summarizeTracts(list));
      }
    } else {
      for (const r of cells) byCounty.set(countyFips(r.geo_id), r);
    }
    let ref = null;
    for (const level of g.reference) {
      const r = mine.find((x) => x.geo_id === refIds[level]);
      if (r) { ref = { cell: r, name: level === 'state' ? names(refIds.state) : 'United States' }; break; }
    }
    if (!ref && g.reference.length) ref = { cell: { value_status: 'missing' }, name: '' };
    return {
      group: g, measure: m, unitWord,
      label: (def?.label ?? m.id) + (m.suffix ? ` — ${m.suffix}` : ''),
      unit: def?.units ?? (def?.rate_basis === 'percent' ? '%' : null),
      period: periodLabel(cells) || periodLabel(mine),
      catchment: summarize(cells, m.agg ?? g.agg, isTract ? cells.length : countyIds.length),
      ref, byCounty,
    };
  });
}
const names = (id) => ctx.names.get(id) ?? id;
const isPercent = (unit) => unit === '%' || unit === 'percent';
const fmt = (v, unit) => formatNumber(v, isPercent(unit) ? 1 : undefined) + (isPercent(unit) ? '%' : '');

function valueCell(cell, unit) {
  return cell.value_status === 'reported' && cell.value != null ? fmt(cell.value, unit) : statusLabel(cell.value_status);
}

// Value text for the map tooltip and county table, with tract coverage when the county value comes from tracts.
function countyText(cell, unit) {
  const coverage = tractCoverage(cell);
  return valueCell(cell, unit) + (coverage ? ` (${coverage})` : '');
}

function catchmentTd(m) {
  const s = m.catchment;
  if (s.status !== 'reported') return `<td class="status">${esc(statusLabel(s.status))}</td>`;
  const what = s.agg === 'sum' ? `sum of ${s.k} ${m.unitWord}` : `${AGG_WORDS[s.agg]} of ${s.k}/${s.n} ${m.unitWord}`;
  const range = s.agg !== 'sum' && s.min !== s.max ? `range ${fmt(s.min, m.unit)}–${fmt(s.max, m.unit)}` : '';
  return `<td class="num"><span class="v">${esc(fmt(s.value, m.unit))}</span><span class="sub">${esc(what)}</span>${range ? `<span class="sub">${esc(range)}</span>` : ''}</td>`;
}

function refTd(m) {
  if (!m.ref) return '';
  const reported = m.ref.cell.value_status === 'reported';
  return reported
    ? `<td class="num"><span class="v">${esc(valueCell(m.ref.cell, m.unit))}</span><span class="sub">${esc(m.ref.name)}</span></td>`
    : `<td class="status">${esc(statusLabel(m.ref.cell.value_status))}</td>`;
}

function tableHtml(modelsByGroup, caption) {
  const groups = modelsByGroup.map((ms) => ms[0].group);
  const units = groups.map((g, i) => [...new Set(modelsByGroup[i].map((m) => m.unit))]);
  const rowKeys = [];
  const rows = new Map();
  modelsByGroup.forEach((ms, gi) => ms.forEach((m) => {
    if (!rows.has(m.label)) { rows.set(m.label, []); rowKeys.push(m.label); }
    rows.get(m.label)[gi] = m;
  }));
  const head = groups.map((g, gi) => {
    const shared = units[gi].length === 1 && units[gi][0] && units[gi][0] !== '%' ? ` · ${units[gi][0]}` : '';
    const cols = 2 + (g.reference.length ? 1 : 0);
    return `<th colspan="${cols}" scope="colgroup" class="grp">${esc(g.title)}<span class="sub">${esc(g.source)} · release ${esc(g.release)}${esc(shared)}</span></th>`;
  }).join('');
  const sub = groups.map((g) => `<th scope="col">Catchment</th>${g.reference.length ? '<th scope="col">Compare</th>' : ''}<th scope="col">Period</th>`).join('');
  const body = rowKeys.map((k) => {
    const per = rows.get(k);
    const cells = groups.map((g, gi) => {
      const m = per[gi];
      if (!m) return `<td class="muted" colspan="${2 + (g.reference.length ? 1 : 0)}">—</td>`;
      return `${catchmentTd(m)}${refTd(m)}<td class="period">${esc(m.period)}</td>`;
    }).join('');
    const own = per.find(Boolean);
    const unitNote = groups.length === 1 && own.unit && own.unit !== '%' && units[0].length > 1 ? ` <span class="sub">${esc(own.unit)}</span>` : '';
    return `<tr><th scope="row">${esc(k)}${unitNote}</th>${cells}</tr>`;
  }).join('');
  const csvId = ctx.csv.push(modelsByGroup.flat()) - 1;
  return `<div class="tbl"><div class="tbl-head"><h3>${esc(caption)}</h3>
    <button type="button" data-csv="${csvId}">Download CSV</button></div>
    <div class="table-wrap" tabindex="0" role="region" aria-label="${esc(caption)} table"><table>
    <thead><tr><th rowspan="2" scope="col">Measure</th>${head}</tr><tr>${sub}</tr></thead><tbody>${body}</tbody></table></div></div>`;
}

function measuresCsv(models) {
  const head = ['measure_id', 'stratum_id', 'label', 'source', 'source_release', 'period', 'unit', 'aggregation', 'catchment_value',
    'catchment_status', 'units_reported', 'units_total', 'min', 'max', 'compare_to', 'compare_value', 'compare_status', 'cancer_basemap_release'];
  return toCsv(head, models.map((m) => {
    const s = m.catchment;
    const ok = s.status === 'reported';
    return [m.measure.id, m.measure.stratum, m.label, m.group.source, m.group.release, m.period, m.unit, s.agg, ok ? s.value : '',
      ok ? 'reported' : statusLabel(s.status), s.k, s.n, s.min, s.max, m.ref?.name, m.ref?.cell.value_status === 'reported' ? m.ref.cell.value : '',
      m.ref ? statusLabel(m.ref.cell.value_status) : '', ctx.manifest.release];
  }));
}

async function renderSection(section, run) {
  let html;
  try {
    const modelsByGroup = await loadGroups(section.tables.flat());
    if (run !== ctx.runId) return;
    let i = 0;
    html = section.tables.map((groupsOfTable) => {
      const ms = modelsByGroup.slice(i, (i += groupsOfTable.length));
      for (const list of ms) for (const m of list) ctx.mapModels.set(`${m.group.key}|${m.measure.id}|${m.measure.stratum ?? ''}`, m);
      return tableHtml(ms, groupsOfTable.map((g) => g.title).join(' and '));
    }).join('');
  } catch (e) {
    html = `<p class="error" role="alert">Could not load this section: ${esc(e.message)}</p>`;
  }
  if (run !== ctx.runId) return;
  $(`#${section.id} .body`).innerHTML = html;
  perf.firstContentMs ??= performance.now();
  fillMapOptions();
}

// ---------- facilities ----------
async function renderFacilities(run) {
  const body = $('#facilities .body');
  try {
    const site = sqlStr(tableUrl(base, ctx.manifest, 'facility', 'site').url);
    const ids = sqlList(ctx.countyIds);
    const [summary, sites] = await Promise.all([
      ctx.query(`SELECT kind, source, any_value(source_release) AS source_release, count(*) AS total,
          count(*) FILTER (geo_id IS NULL) AS unplaced, count(*) FILTER (geo_id IN (${ids})) AS inside,
          count(DISTINCT geo_id) FILTER (geo_id IN (${ids})) AS counties
        FROM read_parquet(${site}) GROUP BY kind, source ORDER BY kind`),
      ctx.query(`SELECT kind, source, name, address, geo_id FROM read_parquet(${site}) WHERE geo_id IN (${ids}) ORDER BY kind, name`),
    ]);
    if (run !== ctx.runId) return;
    const rel = (r) => r.source_release ?? `Cancer Basemap ${ctx.manifest.release}`;
    const kindName = (k) => FACILITY_KINDS[k] ?? k;
    const rowsHtml = summary.map((r) => `<tr><th scope="row">${esc(kindName(r.kind))}</th>
      <td>${esc(r.source)} · ${esc(rel(r))}</td>
      ${r.unplaced === r.total ? `<td class="status" colspan="2">Not placed in a county in this release</td>`
        : `<td class="num"><span class="v">${formatNumber(r.inside)}</span></td><td class="num">${r.counties}/${ctx.countyIds.length}</td>`}
      <td class="num">${formatNumber(r.total)}${r.unplaced && r.unplaced !== r.total ? ` <span class="sub">${formatNumber(r.unplaced)} not placed in a county</span>` : ''}</td></tr>`).join('');
    const sitesCsvId = ctx.csv.push({ sites }) - 1;
    const sumCsvId = ctx.csv.push({ summary }) - 1;
    body.innerHTML = `<div class="tbl"><div class="tbl-head"><h3>Facility sites by kind</h3>
      <button type="button" data-csv="${sumCsvId}">Download CSV</button></div>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Facility sites by kind table"><table>
      <thead><tr><th scope="col">Kind</th><th scope="col">Source · release</th><th scope="col">Sites in catchment</th>
      <th scope="col">Counties with a site</th><th scope="col">Sites nationwide</th></tr></thead><tbody>${rowsHtml}</tbody></table></div></div>
      <details><summary>List the ${formatNumber(sites.length)} sites in the catchment</summary>
      <div class="tbl"><div class="tbl-head"><h3>Sites</h3><button type="button" data-csv="${sitesCsvId}">Download CSV</button></div>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Sites table"><table><thead><tr><th scope="col">Name</th><th scope="col">Kind</th>
      <th scope="col">County</th><th scope="col">Address</th></tr></thead><tbody>${sites.slice(0, 500).map((s) => `<tr><th scope="row">${esc(s.name)}</th>
      <td>${esc(kindName(s.kind))}</td><td>${esc(names(s.geo_id))}</td><td>${esc(s.address)}</td></tr>`).join('')}</tbody></table></div>
      ${sites.length > 500 ? '<p class="muted">The first 500 are shown; the CSV has all of them.</p>' : ''}</div></details>`;
  } catch (e) {
    body.innerHTML = `<p class="error" role="alert">Could not load facilities: ${esc(e.message)}</p>`;
  }
  perf.firstContentMs ??= performance.now();
}

// ---------- map ----------
async function drawMap(run) {
  const holder = $('#map-svg');
  holder.innerHTML = '<p class="muted">Loading county boundaries…</p>';
  try {
    const geo = catchmentGeometry(await ctx.topology, ctx.countyIds.map(countyFips));
    if (run !== ctx.runId) return;
    ctx.geo = geo;
    holder.innerHTML = `<svg viewBox="${geo.viewBox}" role="img" aria-labelledby="map-title">
      <title id="map-title">Map of the ${ctx.countyIds.length} counties in the catchment, shaded by the selected measure</title>
      ${geo.context.map((d) => `<path class="ctx" d="${d}"/>`).join('')}
      ${geo.counties.map((c) => `<path class="county" data-fips="${c.fips}" d="${c.d}"/>`).join('')}
      <path class="outline" d="${geo.outline}"/></svg>`;
    $('#map-note').textContent = geo.missing.length ? `${geo.missing.length} catchment counties are not in the boundary file and are not drawn.` : '';
    paintMap();
  } catch (e) {
    holder.innerHTML = `<p class="error" role="alert">Could not draw the map: ${esc(e.message)}</p>`;
  }
}

function fillMapOptions() {
  const sel = $('#map-measure');
  const byGroup = Map.groupBy([...ctx.mapModels.entries()], ([, m]) => `${m.group.title} (${m.group.source} ${m.group.release})`);
  sel.innerHTML = [...byGroup].map(([title, list]) => `<optgroup label="${esc(title)}">${list.map(([key, m]) =>
    `<option value="${esc(key)}">${esc(m.label)}</option>`).join('')}</optgroup>`).join('');
  const keys = [...ctx.mapModels.keys()];
  sel.value = pickMapKey(keys, ctx.mapWanted);
  paintMap();
}

function paintMap() {
  const m = ctx.mapModels.get($('#map-measure').value);
  if (!m || !ctx.geo) return;
  const url = new URL(location.href);
  url.searchParams.set('map', m.measure.id);
  history.replaceState(null, '', url);
  const vals = [...m.byCounty.values()].filter((c) => c.value_status === 'reported' && c.value != null).map((c) => c.value);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  for (const path of document.querySelectorAll('#map-svg path.county')) {
    const cell = m.byCounty.get(path.dataset.fips);
    const geoId = `county:${path.dataset.fips}`;
    const text = cell ? countyText(cell, m.unit) : statusLabel('missing');
    const reported = cell?.value_status === 'reported' && cell.value != null;
    path.style.fill = reported ? `color-mix(in srgb, var(--primary) ${hi > lo ? 12 + (88 * (cell.value - lo)) / (hi - lo) : 60}%, var(--panel))` : '';
    path.classList.toggle('na', !reported);
    path.innerHTML = `<title>${esc(names(geoId))}: ${esc(text)}</title>`;
  }
  $('#legend').innerHTML = vals.length
    ? `<span>${esc(fmt(lo, m.unit))}</span><span class="ramp" aria-hidden="true"></span><span>${esc(fmt(hi, m.unit))}</span>
       <span class="na-key" aria-hidden="true"></span><span>not reported</span>`
    : '<span>No county in the catchment has a reported value for this measure.</span>';
  $('#map-caption').textContent = `${m.label} — ${m.group.source} release ${m.group.release}, ${m.period}`
    + (m.group.level === 'tract' ? ' (county median of tracts)' : '');
  const rows = ctx.countyIds.map((id) => {
    const cell = m.byCounty.get(countyFips(id));
    const o = ctx.overlap.get(id);
    return `<tr><th scope="row">${esc(names(id))}</th><td class="num">${esc(cell ? countyText(cell, m.unit) : statusLabel('missing'))}</td>
      <td class="num">${o == null ? '' : `${(o * 100).toFixed(o < 0.995 ? 1 : 0)}%`}</td></tr>`;
  }).join('');
  $('#county-table').innerHTML = `<thead><tr><th scope="col">County</th><th scope="col">${esc(m.label)}</th><th scope="col">Share of county in catchment</th></tr></thead><tbody>${rows}</tbody>`;
}

$('#map-measure').addEventListener('change', () => {
  ctx.mapWanted = $('#map-measure').value;
  paintMap();
});

// ---------- CSV downloads ----------
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-csv], #county-csv');
  if (!btn) return;
  const item = btn.id === 'county-csv' ? { counties: ctx.mapModels.get($('#map-measure').value) } : ctx.csv[btn.dataset.csv];
  let csv, name;
  if (Array.isArray(item)) { csv = measuresCsv(item); name = item[0].group.title; }
  else if (item.sites) {
    csv = toCsv(['name', 'kind', 'source', 'county', 'address'], item.sites.map((s) => [s.name, s.kind, s.source, names(s.geo_id), s.address]));
    name = 'facility-sites';
  } else if (item.summary) {
    csv = toCsv(['kind', 'source', 'source_release', 'sites_in_catchment', 'counties_with_site', 'sites_nationwide', 'sites_not_placed_in_county'],
      item.summary.map((r) => [r.kind, r.source, r.source_release, r.inside, r.counties, r.total, r.unplaced]));
    name = 'facility-summary';
  } else {
    const m = item.counties;
    csv = toCsv(['county', 'geo_id', 'value', 'status', 'tracts_reported', 'tracts_total', 'tracts_not_reported', 'measure_id', 'source', 'source_release', 'period', 'cancer_basemap_release'],
      ctx.countyIds.map((id) => {
        const c = m.byCounty.get(countyFips(id));
        return [names(id), id, c?.value_status === 'reported' ? c.value : '', statusLabel(c?.value_status ?? 'missing'),
          c?.tracts?.k, c?.tracts?.n, Object.entries(c?.tracts?.notReported ?? {}).map(([s, n]) => `${s}:${n}`).join(';'), m.measure.id, m.group.source, m.group.release, m.period, ctx.manifest.release];
      }));
    name = `counties-${m.measure.id}`;
  }
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
    download: `${ctx.centerId}-${name}`.replace(/[^\w.-]+/g, '-').toLowerCase() + '.csv',
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

init().catch((e) => {
  console.error(e);
  setStatus(`Could not load ${base}: ${e.message}`, true);
});
