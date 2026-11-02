# Bundled catchment tables

`catchment/center.parquet` and `catchment/member.parquet` are copies of the
`catchment.center` and `catchment.member` tables of Cancer Basemap, built from
Cancer Basemap `main` at commit `6be455ecd4f640ae0daeac619baf4bce45d703bd`
(the `git_sha` in the dev bundle's `manifest.json`, release 2026-11-02). The
published 2026-11-02 release does not carry them yet.

The rows are the NCI Office of Cancer Centers catchment areas, mapped to
counties (vintage 2020). Attribution: DelNero et al., *Cancer Epidemiology,
Biomarkers & Prevention* 2022, doi:10.1158/1055-9965.EPI-21-1230.

The app reads `catchment.*` from the release when its `manifest.json` lists
them, and from these files otherwise. Everything else always comes from the
release.

**Delete this folder** (and the fallback in `js/db.js`) when a Cancer Basemap
release carries `catchment.*`; the first one is scheduled for 2026-12-01.
