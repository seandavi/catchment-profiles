import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseParams, dataBase, tablePath, observationSql, sqlStr, summarize, formatCell, statusLabel, toCsv, stateGeoId, modalValue, median, periodLabel,
} from '../js/lib.js';

test('parseParams reads center, release, data, map', () => {
  assert.deepEqual(parseParams('?center=11&release=v2026-11-02&map=SCP:incidence:001'),
    { center: '11', release: 'v2026-11-02', data: null, map: 'SCP:incidence:001' });
  assert.deepEqual(parseParams(''), { center: null, release: null, data: null, map: null });
});

test('dataBase: data override beats release beats latest', () => {
  assert.equal(dataBase({}), 'https://basemap.cancerdatasci.org/data/latest/');
  assert.equal(dataBase({ release: '2026-11-02' }), 'https://basemap.cancerdatasci.org/data/v2026-11-02/');
  assert.equal(dataBase({ release: 'v2026-11-02' }), 'https://basemap.cancerdatasci.org/data/v2026-11-02/');
  assert.equal(dataBase({ release: 'v1', data: 'http://localhost:8799' }), 'http://localhost:8799/');
});

test('tablePath finds a table in the manifest, or null', () => {
  const manifest = { tables: [{ schema: 'measure', table: 'observation', path: 'measure/observation.parquet' }] };
  assert.equal(tablePath(manifest, 'measure', 'observation'), 'measure/observation.parquet');
  assert.equal(tablePath(manifest, 'catchment', 'center'), null);
});

test('observationSql filters on source, release, measure, stratum and geo ids, and quotes', () => {
  const sql = observationSql('http://x/o.parquet', {
    source: 'SCP', release: 'V3', measureIds: ['SCP:incidence:047'], strata: ['SCP:0:001:00:999'], geoIds: ['county:08031', "o'x"],
  });
  assert.match(sql, /read_parquet\('http:\/\/x\/o\.parquet'\)/);
  assert.match(sql, /source = 'SCP'/);
  assert.match(sql, /source_release = 'V3'/);
  assert.match(sql, /measure_id IN \('SCP:incidence:047'\)/);
  assert.match(sql, /stratum_id IN \('SCP:0:001:00:999'\)/);
  assert.match(sql, /geo_id IN \('county:08031', 'o''x'\)/);
  assert.doesNotMatch(sql, /lower|upper|numerator/);
  assert.match(observationSql('u', { source: 'ACS', release: 'r', measureIds: ['m'], geoIds: ['g'], withCounts: true }), /numerator, denominator/);
  assert.equal(sqlStr("a'b"), "'a''b'");
});

test('observationSql for tracts filters on the county part of the tract id', () => {
  const sql = observationSql('u', { source: 'EJSCREEN', release: '2024', measureIds: ['EJSCREEN:pm25'], tractCountyFips: ['08031'] });
  assert.match(sql, /geo_id BETWEEN 'tract:08031' AND 'tract:08031~'/);
  assert.match(sql, /substr\(geo_id, 7, 5\) IN \('08031'\)/);
  assert.doesNotMatch(sql, /stratum_id IN/);
});

test('a cell that is not reported shows its status, never a number', () => {
  assert.equal(formatCell({ value: 12.3, value_status: 'reported' }), '12.3');
  assert.equal(formatCell({ value: 12.3, value_status: 'suppressed_small_count' }), 'Suppressed (small count)');
  assert.equal(formatCell({ value: null, value_status: 'not_available' }), 'Not available');
  assert.equal(formatCell({ value: null, value_status: 'reported' }), 'Reported');
  assert.equal(statusLabel('something_new'), 'Unreported (something_new)');
});

test('summarize: median over reported cells only, with range and counts', () => {
  const cells = [
    { value: 10, value_status: 'reported' },
    { value: 30, value_status: 'reported' },
    { value: 20, value_status: 'reported' },
    { value: null, value_status: 'suppressed_small_count' },
  ];
  assert.deepEqual(summarize(cells, 'median', 5), { agg: 'median', k: 3, n: 5, value: 20, min: 10, max: 30, status: 'reported' });
});

test('summarize: pooled uses numerator/denominator, falls back to the median without them', () => {
  const pooled = [
    { value: 10, numerator: 10, denominator: 100, value_status: 'reported' },
    { value: 50, numerator: 50, denominator: 100, value_status: 'reported' },
    { value: 90, numerator: 90, denominator: 800, value_status: 'reported' },
  ];
  assert.equal(summarize(pooled, 'pooled', 3).value, 150 / 1000 * 100);
  const bare = pooled.map(({ value, value_status }) => ({ value, value_status }));
  const s = summarize(bare, 'pooled', 3);
  assert.equal(s.agg, 'median');
  assert.equal(s.value, 50);
});

test('summarize: nothing reported gives a status, not a number', () => {
  const s = summarize([{ value: null, value_status: 'suppressed_small_count' }, { value: null, value_status: 'suppressed_small_count' }], 'median', 2);
  assert.equal(s.value, null);
  assert.equal(s.status, 'suppressed_small_count');
  assert.equal(summarize([], 'median', 2).status, 'missing');
});

test('geo helpers', () => {
  assert.equal(stateGeoId('county:08031'), 'state:08');
  assert.equal(modalValue(['a', 'b', 'b']), 'b');
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(periodLabel([{ period_start: '2018', period_end: '2022' }, { period_start: '2023', period_end: '2023' }]), '2018–2022, 2023');
});

test('toCsv quotes commas, quotes and newlines', () => {
  assert.equal(toCsv(['a', 'b'], [['x,y', 'say "hi"'], [null, 'l1\nl2']]), 'a,b\r\n"x,y","say ""hi"""\r\n,"l1\nl2"\r\n');
});
