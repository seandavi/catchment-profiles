// DuckDB-Wasm over HTTP range reads. One connection; each table is read straight from its Parquet file.
import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/+esm';
import { tablePath } from './lib.js';

export async function openDb() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  // The worker script lives on the CDN, so start it through a same-origin blob.
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  // Read byte ranges only; by default DuckDB-Wasm downloads each whole Parquet file.
  // All three flags are needed (cancer-basemap site/playground.qmd).
  await db.open({ filesystem: { reliableHeadRequests: true, allowFullHTTPReads: false, forceFullHTTPReads: false } });
  const conn = await db.connect();
  // Repeated queries on one file then fetch its footer once.
  await conn.query('SET enable_http_metadata_cache = true').catch(() => {});
  return async (sql) =>
    (await conn.query(sql)).toArray().map((r) =>
      Object.fromEntries(Object.entries(r.toJSON()).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])));
}

// Parquet URL for schema.table: from the release's manifest, except catchment.*, which
// falls back to the copy in data/ until a release carries it (data/README.md).
export function tableUrl(base, manifest, schema, table) {
  const path = tablePath(manifest, schema, table);
  if (path) return { url: new URL(path, base).href, bundled: false };
  if (schema === 'catchment') return { url: new URL(`data/catchment/${table}.parquet`, document.baseURI).href, bundled: true };
  throw new Error(`This release has no ${schema}.${table}`);
}
