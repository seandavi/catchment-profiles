# Catchment Profiles

Pick an NCI-designated cancer center and see its catchment area: cancer burden, screening and risk factors,
social context, environment and facilities, with a county map. Every number names its source, source release
and period. Live at **https://seandavi.github.io/catchment-profiles/**

## How it works

1. `index.html` plus a few ES modules in `js/`. No framework, no build step, no bundler.
2. The page reads `manifest.json` of a [Cancer Basemap](https://basemap.cancerdatasci.org/) release, then runs
   SQL over its Parquet files with DuckDB-Wasm (HTTP range reads, so only the needed bytes move).
3. `catchment.center` / `catchment.member` choose the counties; queries filter on `source`, `source_release`,
   `measure_id` and `geo_id`, never whole tables.
4. A county or tract that the source did not report shows its `value_status` label, never a number.
5. The map is `us-atlas` TopoJSON with `topojson.merge` for the catchment outline.

Catchment figures summarize the counties (or, for EJScreen and AirToxScreen, the tracts) that overlap the
catchment: a median with its range, a pooled percentage for ACS, a sum for population. They are not exact
catchment-wide rates, and the page says which one each number is.

## Run locally

ES modules need http, not `file://`:

```sh
npx http-server . -p 8798 -c-1        # or: python3 -m http.server 8798
node --test                           # helpers: status labels, query builders, URL params, summaries
```

To develop against a local copy of a release, serve it with CORS and Range support and point the app at it:

```sh
npx http-server /path/to/release -p 8799 --cors -c-1
# http://localhost:8798/?data=http://localhost:8799/&center=11
```

Google Analytics is not loaded on `localhost` or `127.0.0.1`.

## URL parameters

| Parameter | Meaning |
|---|---|
| `center=<id>` | `catchment.center.center_id` to open (11 is the University of Colorado Cancer Center) |
| `release=<date>` | Read a dated release folder, `v2026-11-02` or `2026-11-02`, instead of `latest/` |
| `data=<url>` | Read the release from this URL (development); wins over `release` |
| `map=<measure_id>` | Measure the map shades |

Default data: `https://basemap.cancerdatasci.org/data/latest/`.

## Data and citation

The data contract is the Cancer Basemap release manifest. Cite the release the page shows:

- Cancer Basemap release `<manifest.release>` (Hugging Face tag `seandavis/cancerbasemap@<release>`).
- NCI catchments: DelNero et al., *Cancer Epidemiol Biomarkers Prev* 2022,
  [doi:10.1158/1055-9965.EPI-21-1230](https://doi.org/10.1158/1055-9965.EPI-21-1230).

Until a release carries `catchment.*`, the app reads those two tables from `data/catchment/` (see
`data/README.md`); everything else comes from the release.

A full profile reads on the order of 100 MB of Parquet through DuckDB-Wasm (its read-ahead grows to 16 MB per
read), so sections below the first load as you scroll to them.

## Add a measure

Edit `js/config.js`. Add the measure's `measure_id` (and `stratum`, if it has several) to a group, check
that `source` and `release` match `measure.observation`, and reload. Labels and units come from
`measure.definition`. A new section or table is a new entry in `SECTIONS`. Look measures up with:

```sql
SELECT measure_id, label, units FROM read_parquet('<DATA>/measure/definition.parquet') WHERE source = 'PLACES';
```

## License

MIT. Built on Cancer Basemap releases; the code here is original and is not derived from Cancer InFocus.
