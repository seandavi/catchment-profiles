// DuckDB-Wasm over HTTP range reads. One connection; each table is read straight from its Parquet file.
import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/+esm';
import { tablePath } from './lib.js';

let theDb;

export async function openDb() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  // The worker script lives on the CDN, so start it through a same-origin blob.
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  theDb = db;
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
  if (schema === 'catchment') return { url: `bundled-catchment-${table}.parquet`, bundled: true };
  throw new Error(`This release has no ${schema}.${table}`);
}

// The bundled catchment files are fetched whole and handed to DuckDB from memory: GitHub Pages
// gzips .parquet for any client that accepts gzip (every browser), and byte ranges then index
// the compressed stream, which DuckDB cannot read. They are ~25 KB, so whole is fine.
export async function registerBundled() {
  for (const table of ['center', 'member']) {
    const res = await fetch(new URL(`data/catchment/${table}.parquet`, document.baseURI));
    if (!res.ok) throw new Error(`bundled catchment.${table}: HTTP ${res.status}`);
    await theDb.registerFileBuffer(`bundled-catchment-${table}.parquet`, new Uint8Array(await res.arrayBuffer()));
  }
}
