# chronozarr v0.3 migration plan

2026-10-03. Migration planning with an executed baseline reader spike (§8); no production code/spec migration performed.

The decision is fixed: chronozarr names the time-series + multiscale profile, libraries and viewer. The baseline contains true stored values in every array, including auxiliary arrays; physical units still require band scale/offset. Star-delta becomes a separate storage extension, excluded from the baseline and unreleased until unaware readers demonstrably reject its encoded data.

## 1. Sources

Read [our v0.2 spec](../spec/CHRONOZARR.md), dated 2026-09-30, including §14 amendments. Retrieved upstream default-branch commit identities and documents on 2026-10-03. Source abbreviations below link to immutable snapshots; section names identify the referenced clauses.

| ID | Source / snapshot | Version/date and authority |
|---|---|---|
| G | [GeoZarr SWG](https://github.com/zarr-developers/geozarr-spec/tree/d636b05abbfaa9851d3f12e91335bda22a127243) | `d636b05`, 2026-07-06; current work composes thematic conventions; a coherent GeoZarr specification is still forthcoming. The advertised `geozarr-spec.md` is absent. |
| O | [Archived OGC draft](https://github.com/zarr-developers/geozarr-spec/tree/82cba263ff53db4a9ab25366e3e3ed3777ff3f77/standard/template) | `archives-2025`, `82cba26`, 2025-12-08; read scope, data model, core and overview encoding. Historical CF/TileMatrixSet design, not current profile authority. |
| F | [Conventions framework](https://github.com/zarr-conventions/zarr-conventions-spec/blob/d8077b612759013c0380c4ee562ade2873141da4/README.md) | `d8077b6`, 2026-06-18; Definition, Registration, Convention Properties. |
| M | [Multiscales](https://github.com/zarr-conventions/multiscales/blob/9b78efa75fef0fed302d9cf880037c569354d860/README.md) | `9b78efa`, 2026-06-12; advertised `v0.1`, Pilot; Configuration, Layout Object, Transform Object, Consolidated Metadata. |
| P | [Proj](https://github.com/zarr-conventions/proj/blob/5ca5b2f92e5c7245f957d9128b289ee535f0720d/README.md) | `5ca5b2f`, 2026-06-12; advertised `v0.1`, Pilot; Properties and Inheritance Rules. |
| S | [Spatial](https://github.com/zarr-conventions/spatial/blob/54d81b7ced0376e63ee10f34db31db7d08dcc28d/README.md) | `54d81b7`, 2026-06-12; advertised `v0.1`, Pilot; Properties, dimensions, transform, registration. |
| N | [ndpyramid attribute](https://github.com/carbonplan/ndpyramid/blob/bad4c49461fe51cde7e1035a0504ed4d8780efa3/docs/schema.md) | `bad4c49`, 2026-04-06; Pyramid schema. Commit snapshot, not a release claim; contains development-version examples. |
| Z | [Zarr v3 core](https://github.com/zarr-developers/zarr-specs/blob/ad8fc8df42441c84039c94569980e485e4c09870/docs/v3/core/index.rst), [indexed sharding](https://github.com/zarr-developers/zarr-specs/blob/ad8fc8df42441c84039c94569980e485e4c09870/docs/v3/codecs/sharding-indexed/index.rst) | `ad8fc8d`, 2026-09-21; Array Metadata, Extensions, must_understand and codec specification. |

Pin these convention schemas by the immutable revisions above. Record their UUIDs and schema/spec identities in `zarr_conventions`. **Measured exception (§8):** M’s pinned schema constrains registration URLs to the literal `refs/tags/v0.1/schema.json` and `blob/v0.1/README.md` URLs; commit-based URLs fail its schema even with the correct UUID. Emit those tag URLs for M, while retaining the immutable revision as the validation/provenance pin. P/S accept the commit-based registration URLs tested here. Pilot status permits breaking changes. Describe v0.3 as aligned with these GeoZarr conventions, not certified against an adopted OGC standard. Do not import O's TileMatrixSet requirements into M's current layout.

## 2. Requirement map

Each row assigns one action to the named rules, including table-field requirements and SHOULD/MAY provisions. Repeated rules are grouped; §3.9 is illustrative, §§11–12 explanatory, and §13 repeats earlier clauses. **Drop** removes our restatement, not upstream obligations. **Keep** retains a profile restriction even when upstream supplies its mechanism. **Gap** identifies unresolved extension work outside the baseline. Align rows quote both sides; existing rule quotations refer to our spec.

| Existing normative rules | Action | v0.3 treatment / upstream section |
|---|---|---|
| §1: exact level-0 roundtrip, dtype preservation, self-description, bounded random access | keep | Preserve scientific guarantees; baseline reads one data chunk per cell/timestep, hence satisfies ≤2. |
| §2: Zarr v3 hierarchy; arrays are leaf nodes | drop | Z, Hierarchy and Metadata. |
| §§2,2.1: numeric consecutive level groups, variable lookup, four-axis order/shape, allowed dtypes equal across levels | keep | Keep `(time,band,y,x)`, uint8/uint16/int16/float32 and variable name declaration. |
| §2.1: regular grid, default slash-separated chunk keys | keep | Narrow storage choices remain profile rules; reference Z's chunk-grid/key definitions. |
| §2.1: full-sized edge chunks; discard elements outside shape | drop | Z, Chunk Grids and Array Metadata/shape; retain profile fill-padding policy separately. |
| §2.1: even constant square chunk size, 256/512 advice, all bands together, north-up cell indexing, ceil grid, derive size from inner chunks | keep | Preserve cell contract, including rejection of neither smaller even sizes nor valid edge cells. |
| §§2.1,2.3: fill equals nodata or zero; nodata attrs, invalid-pixel fill advice | keep | Profile validity contract; remove residual-zero padding from baseline, use ordinary fill. |
| §2.2: int64 epoch-ms CF time/calendar, strictly increasing dates; band string/int32; float64 north-up pixel-centre coordinates | keep | Preserve coordinate encodings, cadence freedom, and geometry. |
| §2.2: identical dimension_names/_ARRAY_DIMENSIONS, coordinate single chunks, same time/band at every level | keep | Retain explicit dimensions and duplication for existing xarray workflows; this is a concrete interoperability requirement, not a v0.2 parser shim. |
| §§2.2,3.5: ISO times/band_names mirrors, exact equality, mirror-first reads without coordinate fetches | keep | Preserve request-saving mirrors and validation. |
| §2.3: dtype/nodata defaults, mask overrides sentinel, no NaN nodata/data advice, absent-mask validity | keep | Preserve missing-data semantics; remove star-delta eligibility column from baseline. |
| §2.3: one-byte bytes-codec endian omission | drop | Z, bytes codec specification. |
| §2.4: mask name, uint8 0/1, dimensions/shape/fill/chunks/keys, every level or none, max reduction, true values | keep | Preserve all mask rules. |
| §2.5: coverage name/layout, uint8 saturated counts, zero meaning, rounded mean, every level or none, independent mask/gap-fill | keep | Preserve all coverage rules; counts at coarser levels remain rounded summaries. |
| §3.1: consolidated metadata recommendation | drop | M, Consolidated Metadata; retain nonconsolidated fallback as reader contract. |
| §§3.1,3.4: ndpyramid list/datasets/type/method/version/args schema | align | Ours: “One entry with `datasets[]`, `type` and `metadata`”; M, Description: “This specification defines a JSON object”. Emit `multiscales.layout`, `asset`, `derived_from`, relative transforms and declared resampling; remove legacy fields and `pixels_per_tile` handling from v0.3. |
| §3.4: ordered consecutive levels; omit tile-size hint | keep | Keep ordering and chunk-derived size; no legacy hint is emitted. |
| §3.2: chronozarr object, version rejection, variable/bands/nodata/optional plane/provenance/volatility/length declarations | keep | Version becomes 0.3.x; object bands only; legacy version handling moves to conversion. Remove temporal encoding/reference/selection fields from baseline. |
| §§3.2–3.3: EPSG-only CRS mirrors and per-AOI projected/native-CRS advice | keep | Preserve EPSG profile restriction and native storage; validate upstream CRS against any retained mirror, rather than treating mirrors as authorities. |
| §3.3: optional proj aliases and reader nonrequirement | align | Ours: “Readers MUST NOT require any of these.” P, Properties: “At least one of `proj:code`, `proj:wkt2`, or `proj:projjson` MUST be provided.” Require declared P with `proj:code` at each spatial array; recommend matching WKT2. |
| §3.3: optional spatial aliases | align | Ours: “The data array SHOULD additionally carry”; S, dimensions: “Required: Yes on arrays”; transform: “Required when `spatial:transform_type` is `"affine"` or omitted.” Require S dimensions/affine transform on data/mask/coverage; explicitly pixel-register. Do not declare S on one-dimensional coordinates or ungeoreferenced volatility. |
| §3.3: six affine coefficients and corner mapping | drop | S, spatial:transform / Coordinate convention / Coefficient ordering; preserve north-up/factor-two restrictions separately. |
| §3.3: resolution progression, same origin; optional duplicate crs/transform and `_CRS` | keep | Keep geometric restrictions. `_CRS` remains optional in the baseline, but is required for CRS recognition by tested GDAL 3.12.4 (§8); `proj:code` alone is insufficient there. Tested GDAL 3.13.3 recognizes `proj:code` with or without `_CRS`, but exposes this group-based pyramid as separate subdatasets, not attached overviews. Do not invent another transform schema. |
| §§3.5,3.7: levels mirror path/resolution/transform/shape/grid, equality, primary/fallback discovery | keep | Mirror paths must equal upstream `layout[].asset`; use canonical S geometry and Z shape as validation sources. |
| §3.6: unique band names/common_name, explicit scales/offsets/units, defaults, physical formula, valid-only math, no CF automatic scaling | keep | Preserve consumer scaling; remove v0.1 string/source-specific fallback from baseline. |
| §3.8: optional provenance with sources/composite/gap_fill restrictions and notes | keep | Preserve provenance rules. |
| §4: none/star-delta support, anchors/map/distance, modular arithmetic/no clamp, unchanged references, measured auto selection/forced omission | align | Ours: “Readers MUST support both.” F, Definition: “Conventions therefore may not change how data are encoded or stored”. Baseline permits only ordinary values; relocate all star-delta rules/selection policy to a separate extension draft. |
| §5: formerly mandatory float32 single-chunk volatility grid, exact differences, invalid inclusion, normalization/clipping/zero cases, nominal schedule for none | keep | Make volatility optional (confirmed §7 decision). When present, keep the current formula and default six-step nominal schedule as publisher policy, independent of storage encoding; preserve decodability versus conformance distinction. |
| §6: factor-two means, ceil/edge replication, invalid handling, wide integer floor/float64 accumulation, mask/coverage reduction | keep | Declare average resampling upstream; profile defines exact rounding, padding and validity. Always reduce true values; no residual stage. |
| §6: constant chunks/consecutive levels, default 1×1 grid stopping, other level counts, scaled-fraction advice | keep | Preserve all restrictions and categorical warning. |
| §7.1: unsharded default/optional time sharding, inner shapes/keys/time mapping/partial shards, positive shard_time, multi-shard readers, host-size advice | keep | Preserve layouts and append suitability; remove anchor-multiple advice from baseline. |
| §7.2: uint64 index/CRC/sentinels/start-end locations/missing shard fill/omitted fill shards | drop | Z, indexed-sharding codec, Index, Index location and Empty chunks. |
| §7.2: end-index writer advice, both-location reader support, cached indices/reused handles | keep | Preserve practical browser restrictions and caching contract. |
| §7.3: optional exact shard_bytes inventory, bounded ranges, HEAD fallback, append length updates | keep | Preserve request hints without claiming lengths immutable across append. |
| §7.4: anchors spanning shards and ≤2 chunks | gap | Cross-array/chunk dependency semantics need storage-extension specification/review; not part of baseline. |
| §8: supported compression/configuration subset, little-endian bytes+one compressor, no excluded codecs, all readers support subset, plane/coordinate chains | keep | Keep browser interoperability subset; reference upstream codec definitions rather than duplicate binary algorithms. |
| §9: GET/404, conditional ranges/206, unchanged bytes, CORS/OPTIONS/exposed headers, immutable cache/TAO advice | keep | Preserve static-host contract. |
| §9: new prefix on re-encode, append exception, metadata-last publication, no listing/content-type dependence | keep | Preserve operational rules; metadata last does not make in-place publication atomic. |
| §9: zarr.json node metadata rather than v2 dotfiles | drop | Z, Metadata. |
| §10: profile/version rejection, mirror/fallback parsing, unsupported codec/dtype errors, LOD selection, validity/physical math, optional-plane reads | keep | v0.3-only baseline path; one data chunk, standard decompression; remove anchors and reconstruction. |
| §10: standard shard decoding and array bounds | drop | Z / indexed sharding; profile caching, request hints and missing-data interpretation remain above. |
| §10: root GET, session caches/prefetch, no coordinate reads required | keep | Consolidated cold open keeps existing metadata-request budget; prefetch true frames. |
| §14: append-only dates; compatible grid/bands/dtype/CRS/nodata/planes, new shape/time/mirrors/volatility/consolidation | keep | Preserve append semantics; no reference-map updates in baseline. |
| §14: old chunk bytes/coordinates fixed, only trailing shard replaced, same new pyramid derivation, finite-shard advice | keep | Preserve unsharded/new-object and sharded/rewrite behavior; remove fixed-anchor provisions to extension. |
| §14: working-copy validation, short mutable-object TTLs, upload order, old-root snapshot/reopen and stale-index recovery | keep | Preserve reader snapshots and publishing sequence; do not promise unchanged offsets for an arbitrary writer merely because one zarr-python version preserves them. |
| Missing upstream declaration in §§3,10 | align | Ours, §3.1: “Exactly one entry.” (the legacy `multiscales` requirement); F, Registration requires “`zarr_conventions` - an array”. Add explicit F declarations for chronozarr/M/P/S on applicable nodes, with pinned schema/spec URLs. |

## 3. Baseline spec v0.3 outline

### 0. Scope and upstream references
Name the true-value profile and pin F/M/P/S/Z; inherit their rules by reference.
### 1. Scientific and access guarantees
Exact level-0 stored values, dtype preservation and one data-chunk access per cell/timestep.
### 2. Time-series array profile
Axis order, dtypes, coordinates, north-up layout, chunk restrictions and variable names.
### 3. chronozarr attributes and mirrors
Version, times, bands, levels and authoritative-source equality/fallbacks.
### 4. Validity, units and provenance
Nodata, mask, coverage, physical scaling and source/gap-fill records.
### 5. Overview semantics
Exact factor-two reduction, padding, rounding and fraction/categorical guidance.
### 6. Volatility
Optional true-value temporal-change ordering metric and its existing normalization.
### 7. Storage interoperability restrictions
Compression subset, unsharded default, optional time shards and request hints.
### 8. Static publishing and append
Host headers, immutable objects, working copies, publication order and snapshot semantics.
### 9. Consumer contract
Profile rejection, metadata fallbacks, LOD, valid physical values and caching.

## 4. Fail-closed star-delta

Prefer an array-level Zarr storage extension with `must_understand: true`, subject to the tests below. Guard each residual-bearing array and the extension store's root; root-only rejection is bypassable by direct-array opens. Attribute flags are not guards. F's convention metadata object cannot gain a `must_understand` field. Z's Extensions / must_understand requires rejection of unknown mandatory metadata, but actual implementations differ.

Reader evidence, inspected without executing fixtures:

| Reader | Source/version read; expected behavior |
|---|---|
| zarr-python 3 | [3.1.6 metadata](https://github.com/zarr-developers/zarr-python/blob/v3.1.6/src/zarr/core/metadata/v3.py), 2026-03-19; [3.4.0 metadata](https://github.com/zarr-developers/zarr-python/blob/v3.4.0/src/zarr/core/metadata/v3.py), 2026-09-15. Both reject extra fields unless explicitly ignorable; unknown codecs/dtypes fail. Their array layers ([3.1.6](https://github.com/zarr-developers/zarr-python/blob/v3.1.6/src/zarr/core/array.py), [3.4.0](https://github.com/zarr-developers/zarr-python/blob/v3.4.0/src/zarr/core/array.py)) explicitly reject nonempty storage transformers. |
| xarray | [open_zarr documentation](https://docs.xarray.dev/en/stable/generated/xarray.open_zarr.html), updated 2026-09-29. Native Zarr backend delegates storage to zarr-python; test both pinned Python versions. Do not use the chronozarr engine as an unaware reader. |
| GDAL 3.12 | [v3.12.0 LoadArray](https://github.com/OSGeo/gdal/blob/v3.12.0/frmts/zarr/zarr_v3_array.cpp). Unknown top-level fields warn and continue; nonempty storage_transformers fail; unsupported dtype/codec expected to fail. |
| GDAL 3.13 | [v3.13.0 LoadArray](https://github.com/OSGeo/gdal/blob/v3.13.0/frmts/zarr/zarr_v3_array.cpp), tag commit 2026-05-04. Same unknown-field warning/nonempty-transformer rejection. [Driver docs](https://gdal.org/en/stable/drivers/raster/zarr.html), read 2026-10-03, document new sharding, spatial/proj and multiscales support, not star-delta safety. |
| zarrita 0.7.5 | [Published package](https://registry.npmjs.org/zarrita/0.7.5), inspect `dist/src/open.js`, `hierarchy.js`, `util.js`, `codecs.js`. No unknown-top-level guard found; unknown dtype/codec errors exist, codec rejection may wait until chunk access. Storage-transformer metadata is not enforced in those paths. |
| zarr-layer 0.10.0 | [Store source](https://github.com/carbonplan/zarr-layer/blob/64ce590a8640331b18d6cefa3ceed84c77af12e3/src/zarr-store.ts), 2026-09-22. Already parses both multiscales schemas; delegates arrays to zarrita (`^0.7.1`). Pin resolved zarrita 0.7.5 for this matrix. Unsupported layout/open failure alone is not evidence of extension rejection. |

| Mechanism | Safety and access/append consequences (analytical, not measured) |
|---|---|
| A: unknown mandatory top-level storage extension | Intended unaware rejection, but expected GDAL/zarrita failures of enforcement below. Unchanged payloads; ≤2 data chunks; no extra metadata GET when consolidated. Append retains guards and fixed references. |
| B: separately named anchors/residuals, no true-value series | Naming prevents advertising residuals as measurements but does not prevent raw reads. Two arrays/two chunks; extra metadata GETs without consolidation, potentially two shard indices; append both arrays/map. Not fail-closed alone. |
| C: unknown codec guard | Unaware codec resolution/read should fail. Zero extra metadata GETs; two-chunk bound and append unchanged only with a real dependency-aware extension. A conventional codec cannot fetch an anchor in another chunk; do not ship a fake no-op codec as storage semantics. |
| D: unknown data_type | Unknown type should fail; costs like C. Requires defined encoded type and restoration to original dtype; plain dtype preservation no longer describes physical storage. |
| E: nonempty storage_transformers | GDAL and Python explicitly reject; zarrita appears to ignore. No extra metadata GET; a genuine key/value storage mapping might retain two reads, but cross-chunk reconstruction needs separate review. |
| F: attribute/version/dtype-value tripwire | Attribute flags or unusual valid values can be ignored; no guaranteed rejection. No request/append change; unsuitable. Invalid metadata is not a valid extension design. |
| G: full true-value data plus residual accelerator | Unaware public-array reads stay correct, rather than reject. Two accelerator chunks/one public chunk; extra array metadata absent consolidation; duplicate writes/storage on append. Separate accelerator store still needs its own fail-closed guard; no unguarded residual arrays in baseline. |

### Deferred mechanism × reader matrix

R = rejection expected from source; I = ignored/unsafe expected; U = unresolved; V = true values; S = separately named raw residuals remain readable. These are hypotheses, not passing results. The release requirement for extension mechanisms is **R in every unaware-reader cell**, with no residual returned; I/U block release until fixed and verified.

| Mechanism | zarr-python 3.1.6 / 3.4.0 | xarray on each | GDAL 3.12 | GDAL 3.13 | zarrita 0.7.5 | zarr-layer + pinned zarrita |
|---|---|---|---|---|---|---|
| A mandatory array/root field | R / R | R / R | I | I | I | I |
| B named residuals only | S / S | S / S | S | S | S | S if selected |
| C unknown codec | R / R | R / R | R | R | R on read | R on read/render |
| D unknown data_type | R / R | R / R | R | R | R | R |
| E storage transformer | R / R | R / R | R | R | I | I |
| F attributes only | I / I | I / I | I | I | I | I |
| G true-value public series | V / V | V / V | V | V | V | V |

Later verification: build tiny three-date/two-level fixtures with a known large wrapped residual, no unrelated unsupported codec, plus baseline controls. Exercise local and HTTP opens, root/group/direct-array entry points, consolidated/nonconsolidated metadata, sharded/unsharded arrays and sparse/fill cases. GDAL 3.12's sharding failure does not count as a guard pass: require unsharded coverage. Force every non-anchor array slice and render a selected non-anchor date; record exceptions, warnings, returned values and framebuffer/no-paint state. A lazy successful open is provisional; numeric output before rejection fails. Empty/all-fill selections must not bypass mandatory guards. Verify aware decoding against exact source values, count cold/cached data fetches separately from metadata/index requests, then append/reopen and compare old chunks/references. Capture exact reader/build/dependency versions. No experiment runs in this task.

## 5. Code impact and legacy policy

Recommend **explicit `chronozarr convert` v0.2 → v0.3**, not dual-version baseline readers. Current CLAUDE.md has no shim prohibition text; this choice follows the user's stated no-unneeded-shims constraint. Existing v0.2 artifacts remain unchanged and readable with pinned v0.2 libraries/viewer. Migration is necessary before a v0.3-only reader/viewer can open them; no automatic URL fallback.

| Component | Required later change |
|---|---|
| `schema.py` | Emit/validate F registrations, object M layout and required P/S; version 0.3; ordinary-value schema only. Rebase mirrors on upstream sources; reject legacy layout/encoding with conversion guidance. |
| `encode.py` | Write true values only; remove auto/star-delta selection from baseline, retain pyramid/validity/volatility/chunks. Emit canonical upstream metadata and consolidate last. |
| `decode.py` | Read v0.3 metadata and ordinary chunks; preserve physical/validity/lazy/shard paths. Reject v0.2 and unknown mandatory extensions before producing values. |
| `backend.py` | Preserve lazy indexing and physical/raw options; report profile identity without anchor metadata. Native xarray sees stored values, not automatically band-scaled units. |
| `convert.py` | Add explicit legacy source importer, reconstruct v0.2 residuals before writing, retain coordinates/scales/masks/coverage/provenance. Migration-specific parser stays out of normal read paths. |
| `stac.py` | Identify v0.3 profile/pinned conventions; advertise true-value Zarr asset; remove anchor/encoding summaries from baseline. Keep STAC projection metadata in its own schema. |
| JS `metadata.js` | Parse M layout/F/P/S and profile mirrors; accept 0.3 baseline only; eliminate legacy string-band and ndpyramid fallback. |
| JS `decoder.js` | Single data-chunk path; remove anchor reconstruction/ordering from baseline, retain workers/cache/volatility/prefetch and shard recovery. |
| Also `append.py`, CLI, fixtures, viewer/MapLibre/notebooks/docs | Remove baseline encoding options/assumptions, update publishing and version errors, regenerate validation controls; do not silently retain legacy shader semantics. |

Implementation sequence: pin/schema and spec rewrite → writer/converter → readers/integrations → fidelity/native-client/append checks → publish migrated demo at a new prefix → v0.3 release. For v0.2 `none`, copy unchanged data/plane/coordinate chunks and rebuild metadata; for star-delta, rewrite reconstructed data chunks. Preserve existing overview pixels instead of rerounding them. Validate every level, timestamp, band, mask/coverage, physical value and provenance before publication; leave originals intact. Measure existing read-path gates before/after the later reader changes. Extension development/release is a separate gated sequence.

## 6. Upstream asks

Proposed only; no issues/PRs filed. None blocks ordinary-value v0.3 when the pinned conventions can be emitted and validated. Extension blockers do not delay baseline release.

| Repository | Issue/PR description | Blocks v0.3? |
|---|---|---|
| `zarr-conventions/multiscales` | Example PR: native-AOI time/band pyramid with precise average/validity rules and consolidated discovery. | No |
| `zarr-conventions/zarr-conventions-spec` | Documentation issue: distinguish ignorable temporal interpretation from mandatory cross-chunk storage decoding. | No |
| `zarr-developers/geozarr-spec` | Fix obsolete draft reference and list chronozarr profile after conformance evidence. | No |
| `zarr-developers/zarr-specs` | Review dependency-aware star-delta extension, per-array guard and direct/consolidated rejection fixtures. | No; extension blocker |
| `OSGeo/gdal`, `manzt/zarrita.js` | Reproduce unknown mandatory-field acceptance and require failure before values, including sparse reads. | No; extension blocker for A |
| `carbonplan/zarr-layer` | Add profile conformance/render tests and propagate mandatory-extension errors; do not request already-present layout parser. | No; extension blocker where errors are swallowed |
| `zarr-developers/zarr-python`, `pydata/xarray` | Add shared rejection fixtures; file fixes only for verified failures in later matrix. | No; extension blocker if failures occur |
| `zarr-conventions` / GeoZarr SWG | Scope future temporal/band/validity/coverage convention ownership; repo TBD with maintainers. | No; keep local rules meanwhile |

## 7. Confirmed scope decisions

1. v0.3 readers do not support v0.2; existing stores require explicit conversion.
2. Star-delta extension work and its reader population are deferred and outside this spike.
3. v0.3 is restricted to EPSG north-up grids.
4. Volatility is optional; the fixture deliberately omits it.

## 8. Reader spike

Executed locally on 2026-10-03, before any production spec or reader rewrite. The hand-built fixture is produced by [`scripts/spike_v03_fixture.py`](../scripts/spike_v03_fixture.py), independently of `src/chronozarr`. Output `data/spike/v03/` is gitignored: Zarr v3, true-value uint16, three dates (2024-01/02/03-01), two bands (red/nir; int32 coordinate indices 0/1), two level groups (8×8 and 4×4), EPSG:32618, 10/20 m north-up pixels, unsharded zstd level 5, constant 8×8 spatial chunks, and uint8 masks at both levels. The origin is (500000, 4500000); both extents are [500000, 4499920, 500080, 4500000]. Each source 2×2 block is constant, so valid-only integer mean overviews are independently exact; the lower-right block is invalid and filled with zero. No temporal encoding, volatility, `_CRS`, or legacy ndpyramid metadata is emitted.

Registrations: M on the root, P/S on all four spatial arrays, no S on coordinate arrays. M/P/S metadata passes the actual JSON schemas fetched at the §1 commit pins (jsonschema 4.26.0). M registration uses its schema-required tag URLs, as corrected in §1. The chronozarr root registration points to this experimental plan: **a published normative v0.3 schema/spec URL does not exist yet**, so this fixture does not pretend to register one. Kept attrs include object bands, names/times/levels mirrors, native CRS, nodata=null and mask_variable. Consolidated metadata is written last.

“Recognized” below means a reader assigned CRS/projection semantics, rather than merely retaining a JSON attribute. “Pyramid” distinguishes level enumeration from attaching native overviews. All tests forced data reads; a lazy open alone was not counted as success.

| Reader (exact version) | Opens? | CRS recognized? | Georeferencing correct? | Pyramid levels discovered? | Known pixels match? | Warnings / limitations |
|---|---|---|---|---|---|---|
| zarr-python 3.1.6; Python 3.11.6; NumPy 2.4.4 | Yes, root and arrays | No semantic CRS API; P attrs retained | Transform and x/y metadata retained correctly; no reprojection | Both child groups enumerated; no multiscales interpretation | Yes, all 6 data/mask samples | None on open/read. Fixture consolidation suppresses Zarr’s standard experimental-v3-consolidation warning. |
| xarray 2026.2.0 (`open_zarr`, native backend; zarr-python 3.1.6) | Yes; root is an empty Dataset; `group="0"` / `"1"` yields data | No CRS object assigned; attrs retained | Both x/y pixel-centre grids exactly correct, CF times decoded | No automatic pyramid discovery; each group opened explicitly | Yes, all 6; uint16/uint8 preserved | None. Root open does not return the series. |
| GDAL 3.12.4 “Chicoutimi” (Homebrew CLI, released 2026-04-22) | Yes, root MD hierarchy and selected raster slices | **No** with P alone; **yes** in separate `_CRS` control | Yes, both affine transforms and sampled pixel centres | Both levels listed as independent subdatasets; **no attached overviews** | Yes, all 6 via `gdal_translate` XYZ | `gdalmdiminfo -detailed` emits `Size of _ARRAY_DIMENSIONS[0] different from the one of shape` twice; selected raster reads emit none. Traced to root-group reopening of `/1/x` and `/1/y`, not inconsistent fixture metadata (details below). GDAL reports fill=0 as NoData and does not automatically apply the separate mask. |
| GDAL 3.13.3 “Iowa City” (official ubuntu-small image, Linux arm64; released 2026-08-13) | Yes, MD hierarchy and selected raster slices | **Yes**, EPSG:32618 with `_CRS`, without it in the original, and after removal from a copy | **Yes**, 10/20 m north-up transforms and sampled centres | Both levels exposed as independent data/mask subdatasets; **no attached overviews** | **Yes**, all 6 in each of 3 variants | **None**: stderr empty for all 30 MD-info/root-info/level-info/pixel-read commands. Image build/digest below. |
| zarrita 0.7.5; Node 24.16.0; @zarrita/storage 0.2.0; numcodecs 0.3.2 | Yes, direct arrays | No geospatial interpretation; P attrs readable | Raw affine metadata correct; no projection API | Layout is metadata, not automatic pyramid selection | Yes, all 6 | None. Local filesystem Readable store. |
| @carbonplan/zarr-layer 0.10.0 + zarrita 0.7.5; Node 24.16.0; proj4 2.22.0 | Yes, real `ZarrLayer.initialize()` | **Yes**, `describe().proj4="EPSG:32618"`; origin projects to [-75, 40.65085651557158] | Yes, exact UTM extent and descending y; data arrays opened at both resolutions | **Yes**, `levelAssets=["0","1"]` from M layout | Yes, 4 data samples via layer-owned arrays; masks separately verified with zarrita | None. `describe().crs` stays `EPSG:4326` while `proj4` holds the effective UTM projection. Node tests plus **browser WebGL render verified** with MapLibre 5.15.0 (in-app Chrome/154.0.0.0 UA); map-location query returns 1107. Browser requires no CRS/bounds/spatialDimensions override. Explicit spatialDimensions was used only in the earlier Node check. Separate mask is not automatically interpreted by zarr-layer. |

Known sample oracle (index order follows the array):

| Array / index | Expected |
|---|---:|
| `0/data[0,0,0,0]` | 1 |
| `0/data[1,1,2,4]` | 1107 |
| `0/data[2,0,5,1]` | 2009 |
| `1/data[2,1,2,0]` | 2109 |
| `0/mask[2,7,7]` | 0 |
| `1/mask[2,3,3]` | 0 |

Reproduce (the script refuses to overwrite an existing fixture):

```sh
uv run python scripts/spike_v03_fixture.py
mkdir -p /tmp/chronozarr-v03-node
npm install --prefix /tmp/chronozarr-v03-node @carbonplan/zarr-layer@0.10.0 zarrita@0.7.5
uv run python scripts/spike_v03_fixture.py --verify --node-project /tmp/chronozarr-v03-node
gdalmdiminfo -detailed data/spike/v03
gdalinfo 'ZARR:"data/spike/v03":/0/data:1:1'
```

Use `--output <new-path>` for a fresh fixture. `--verify` checks an existing one and runs whichever GDAL CLI is on PATH; its version is printed. JavaScript tests use the actual installed package, its layer-owned array handles and the same zarrita dependency, without modified package sources. Record `npm ls --prefix /tmp/chronozarr-v03-node --depth=1` because transitive versions can change.

Additional GDAL control: copied the fixture to `data/spike/v03_gdal_crs_control/`, added array `_CRS={"url":"http://www.opengis.net/def/crs/EPSG/0/32618"}` on data/mask, reconsolidated, then repeated `gdalinfo`. It assigned WGS 84 / UTM zone 18N with EPSG ID 32618; the main fixture remains free of that alias.

Outcome: ordinary-value storage and M layout work in the tested Python/JS readers, and GDAL 3.12.4 reads the same numeric arrays. This is not evidence that every reader interprets the conventions: xarray requires level selection, GDAL 3.12 needs `_CRS` for CRS assignment and does not attach the pyramid, and zarr-layer’s effective projection is in `proj4`. Commit-URL registration for M was disproved and corrected in §1; volatility and legacy-reader scope are corrected in §2/§7. GDAL 3.13.3 and local HTTP/browser render placement are now verified below. Cross-origin CORS, append, performance and extension safety remain untested here.

### GDAL 3.13 completion and image provenance

Used the official `ghcr.io/osgeo/gdal:ubuntu-small-3.13.3` image, Linux arm64, built **2026-08-18T09:42:42.992987247Z**, well before the seven-day cutoff of 2026-09-26. Immutable pulled manifest digest: `sha256:64250faf833c06d4b21afce4c27190039ba7ab58d70f0eebc87cf77d929c0b40`. The [OSGeo announcement](https://lists.osgeo.org/pipermail/gdal-dev/2026-August/061737.html) identifies this official tag. `gdalinfo --version` reports `GDAL 3.13.3 "Iowa City", released 2026/08/13`. Docker 29.4.0 was started; the earlier unavailable-daemon limitation is resolved. No quarantine setting was changed. An unused conda dry-run was abandoned when its 3.13.3 dependencies required packages newer than seven days; no conda environment was installed.

Ran each command family against (a) original `v03`, which already lacks `_CRS`; (b) `v03_gdal_crs_control`, which has the array `_CRS` alias; and (c) an explicit copy of (b), `v03_without_crs`, with `_CRS` removed from every array and consolidated metadata entry. All three assign EPSG:32618. Per-level raster geotransforms (GDAL order) are:

- Level 0: `[500000, 10, 0, 4500000, 0, -10]`.
- Level 1: `[500000, 20, 0, 4500000, 0, -20]`.

Every root raster listing exposes `/0/data`, `/0/mask`, `/1/data`, `/1/mask` as subdatasets. Neither selected data slice has an `overviews` entry. All six oracle values match in each variant. **Every warning: none**—all 30 command stderr streams are empty. Full command/stdout/stderr records are saved locally in `data/spike/v03_render/gdal313-results.json` (gitignored).

Representative invocation, with the fixture mounted read-only:

```sh
docker run --rm -v "$PWD/data/spike:/spike:ro" \
  ghcr.io/osgeo/gdal@sha256:64250faf833c06d4b21afce4c27190039ba7ab58d70f0eebc87cf77d929c0b40 \
  gdalinfo -json 'ZARR:"/spike/v03_without_crs":/0/data:1:1'
```

The full matrix uses `gdalmdiminfo -detailed`, root `gdalinfo -json`, selected `gdalinfo -json` at each level, and six `gdal_translate -q -srcwin <col> <row> 1 1 -of XYZ ... /vsistdout/` calls per variant. The known samples are the oracle table above.

### Cause of the two GDAL 3.12 warnings

Verbatim stderr from `gdalmdiminfo -detailed data/spike/v03`, repeated on the follow-up run:

```text
Warning 1: Size of _ARRAY_DIMENSIONS[0] different from the one of shape
Warning 1: Size of _ARRAY_DIMENSIONS[0] different from the one of shape
```

These are a **GDAL 3.12.4 root-group dimension-cache/path-resolution problem, not a fixture error**. The message is misleading: the [v3 loader’s FindDimension](https://github.com/OSGeo/gdal/blob/v3.12.4/frmts/zarr/zarr_v3_array.cpp#L1212) emits that legacy `_ARRAY_DIMENSIONS` text while processing v3 `dimension_names`. It warns when a cached same-name dimension has a different size. The [MD-info serializer](https://github.com/OSGeo/gdal/blob/v3.12.4/apps/gdalmdiminfo_lib.cpp#L750) reopens an indexing variable using `rootGroup->OpenMDArray(fullName)`. In 3.12, [OpenMDArray delegates directly to OpenZarrArray](https://github.com/OSGeo/gdal/blob/v3.12.4/frmts/zarr/zarr.h#L456); [OpenZarrArray loads through its receiving group](https://github.com/OSGeo/gdal/blob/v3.12.4/frmts/zarr/zarr_v3_group.cpp#L39), so those absolute-path reopens share the root’s dimension-name cache across levels.

A GDAL 3.12.4 Python error callback isolated the first warning to `root.OpenMDArray("/1/x")` and the second to `root.OpenMDArray("/1/y")`, after the corresponding level-0 indexing variables were opened. Level-0 x/y are length 8; level-1 x/y are length 4. The root-opened level-1 arrays consequently receive anonymous `dim0` of size 4. Opening the same arrays through `root.OpenGroup("1").OpenMDArray("x"/"y")` returns named x/y of size 4 without warnings. All twelve individually selected `gdalmdiminfo -array /<level>/<array>` calls also emit none. Removing `_ARRAY_DIMENSIONS` from both ordinary and consolidated metadata leaves the same two warnings; removing consolidated metadata also leaves them. GDAL 3.13.3’s full MD-info traversal emits neither warning.

The fixture declares consistent local dimensions: data `(3,2,8,8)` / `(3,2,4,4)`, mask `(3,8,8)` / `(3,4,4)`, and local time/band/x/y coordinates of the corresponding lengths, with matching `dimension_names` and `_ARRAY_DIMENSIONS`. Different spatial lengths in different level groups are intentional. **No script fix is warranted**; renaming dimensions or changing correct shapes to silence this reader behavior would distort the fixture. The original Python/JS/GDAL 3.12 numeric verification was rerun and still passes all samples and both coordinate grids.

### Browser render and map-location check

Loaded the fixture over local HTTP in the **Codex browser pane**, using the actual @carbonplan/zarr-layer **0.10.0**, zarrita **0.7.5**, MapLibre GL **5.15.0**, and proj4 **2.22.0**, bundled with esbuild **0.25.12**. Browser user agent reports Chrome/**154.0.0.0**. The page contains a real MapLibre custom layer and WebGL-rendered grayscale raster; the background is a solid style with no external basemap. Projection/extent/axis orientation come from the fixture metadata, with no CRS, bounds, or spatialDimensions override.

Rendered February 2024 / nir using explicit **index selectors** `{time:{selected:1,type:"index"}, band:{selected:1,type:"index"}}`. This avoids treating the indices as epoch-ms coordinate values. At the centre of level-0 row 2, column 4, UTM `[500045,4499975]`, projected lon/lat **[-74.99946773303368, 40.65063129468804]**, the public `layer.queryData(Point, undefined, {level:"finest"})` returns **1107**, with x/y coordinates exactly equal to that pixel centre. The screenshot shows the rendered footprint and red ring at that map location, together with expected/returned values. This verifies the requested value at its rendered map location; it does not claim a quantitative framebuffer-color calibration or automatic use of the separate mask. Final page warnings: none.

Local evidence and harness (all gitignored): `data/spike/v03_render/index.html`, `main.mjs`, `bundle.js`, `maplibre.css`, `browser-result.json`, and **`screenshot.jpg`**. The final browser tab remains open at `http://127.0.0.1:8873/v03_render/`; it is served by `uv run python -m http.server 8873 --bind 127.0.0.1 --directory data/spike`. The screenshot is a full-page browser capture, not a separately drawn imitation of the renderer. The evidence files persist locally; they are not included in the documentation commit.
