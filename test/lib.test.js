import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseParams, dataBase, tablePath, observationSql, sqlStr, summarize, formatCell, statusLabel, toCsv, stateGeoId, modalValue, median, periodLabel,
  customDataHost, httpUrl, summarizeTracts, tractCoverage, pickMapKey,
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

test('httpUrl links only http(s) URLs', () => {
  assert.equal(httpUrl('https://cancer.example.org/a?b=1'), 'https://cancer.example.org/a?b=1');
  assert.equal(httpUrl('http://cancer.example.org/'), 'http://cancer.example.org/');
  assert.equal(httpUrl('javascript:alert(1)'), null);
  assert.equal(httpUrl('data:text/html,<script>1</script>'), null);
  assert.equal(httpUrl('www.cancer.example.org'), null);
});

test('customDataHost is null for the default data host and the host otherwise', () => {
  assert.equal(customDataHost(dataBase({})), null);
  assert.equal(customDataHost(dataBase({ release: '2026-11-02' })), null);
  assert.equal(customDataHost('http://localhost:8799/'), 'localhost:8799');
  assert.equal(customDataHost('https://evil.example/data/'), 'evil.example');
});

test('observationSql rejects a county FIPS that is not 5 digits and quotes the tract bounds', () => {
  const args = (fips) => ['u', { source: 's', release: 'r', measureIds: ['m'], tractCountyFips: fips }];
  assert.throws(() => observationSql(...args(["08031' OR 1=1 --"])), /5-digit/);
  assert.throws(() => observationSql(...args(['8031'])), /5-digit/);
  assert.match(observationSql(...args(['08059', '08031'])), /geo_id BETWEEN 'tract:08031' AND 'tract:08059~'/);
});

test('summarizeTracts keeps reported/total tracts and the non-reported statuses with the county value', () => {
  const tracts = [
    { value: 10, value_status: 'reported' }, { value: 30, value_status: 'reported' },
    { value: null, value_status: 'suppressed_small_count' }, { value: null, value_status: 'suppressed_small_count' },
    { value: null, value_status: 'not_available' }, { value: 20, value_status: 'reported' },
  ];
  const c = summarizeTracts(tracts);
  assert.deepEqual(c, { value: 20, value_status: 'reported', tracts: { k: 3, n: 6, notReported: { suppressed_small_count: 2, not_available: 1 } } });
  assert.equal(tractCoverage(c), 'median of 3 of 6 tracts reported; 2 Suppressed (small count), 1 Not available');
  assert.equal(tractCoverage({ value: 5, value_status: 'reported' }), '');
});

test('a county with no reported tract shows its status, never a number', () => {
  const c = summarizeTracts([{ value: 9, value_status: 'suppressed_small_count' }, { value: null, value_status: 'suppressed_small_count' }]);
  assert.equal(c.value, null);
  assert.equal(c.value_status, 'suppressed_small_count');
  assert.equal(formatCell(c), 'Suppressed (small count)');
  assert.equal(tractCoverage(c), '0 of 2 tracts reported; 2 Suppressed (small count)');
});

test('pickMapKey keeps the requested measure until its section loads, then selects it', () => {
  const burden = ['burden|SCP:incidence:001|', 'burden|SCP:incidence:047|'];
  const places = 'places|PLACES:CSMOKING:age_adjusted|';
  assert.equal(pickMapKey(burden, 'PLACES:CSMOKING:age_adjusted'), burden[0]); // not loaded yet: default
  assert.equal(pickMapKey([...burden, places], 'PLACES:CSMOKING:age_adjusted'), places); // loaded: by measure id
  assert.equal(pickMapKey([...burden, places], places), places); // by full key
  assert.equal(pickMapKey([...burden, places], burden[1]), burden[1]); // the user chose another measure
  assert.equal(pickMapKey([places], null), places);
  assert.equal(pickMapKey([], 'x'), '');
});
