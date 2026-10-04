# chronozarr v0.3.0

**Status:** Draft

**Date:** 2026-10-03

**Spec version string:** `0.3.0`

**Supersedes:** chronozarr v0.2.0 through explicit store conversion. This draft does not assert that existing chronozarr libraries implement v0.3.0.

## 0. Scope and upstream references

chronozarr defines a true-value raster time-series profile of Zarr v3, with a multiscale pyramid, band descriptions, validity planes, metadata mirrors and static publishing rules. Every array contains ordinary stored values. Physical units are obtained by applying the declared band scale and offset; stored values need no chronozarr-specific reconstruction. The profile supports a single EPSG north-up grid per store. It composes the zarr-conventions **multiscales**, **proj** and **spatial** conventions; it is aligned with this GeoZarr convention work, not certified against an adopted OGC GeoZarr standard.

MUST, MUST NOT, SHOULD, SHOULD NOT and MAY express requirements as in RFC 2119. Sections 0.3 and 10, examples explicitly labelled informative, and implementation observations are informative. Other sections are normative. Upstream requirements incorporated below apply in addition to chronozarr restrictions. Registration URLs identify the literal v0.1 conventions; snapshot identities are documentation provenance, not store attributes.

### 0.1 Normative upstream authorities

| ID | Authority | Sections used by this profile |
|---|---|---|
| Z | [Zarr core 3.1](https://zarr-specs.readthedocs.io/en/latest/v3/core/) | Concepts and terminology (Hierarchy), Stored representation, Metadata, Array metadata, Group metadata, Chunk grids, Chunk encoding, Storage and Extensions. The store's `zarr_format` remains 3. |
| F | [Zarr Conventions Specification](https://github.com/zarr-conventions/zarr-conventions-spec/blob/d8077b612759013c0380c4ee562ade2873141da4/README.md) | Definition, Convention Registration via `zarr_conventions`, Convention Properties and Composability. |
| M | [multiscales v0.1](https://github.com/zarr-conventions/multiscales/blob/v0.1/README.md) | Configuration, Layout Object, Transform Object, Hierarchical Layout, Group Discovery Methods and Consolidated Metadata. |
| P | [proj v0.1](https://github.com/zarr-conventions/proj/blob/v0.1/README.md) | Properties and Inheritance Rules. |
| S | [spatial v0.1](https://github.com/zarr-conventions/spatial/blob/v0.1/README.md) | Properties, spatial:dimensions, spatial:transform, Coordinate convention, Coefficient ordering and spatial:registration. |
| B | [Zarr bytes codec](https://zarr-specs.readthedocs.io/en/latest/v3/codecs/bytes/) | Codec configuration and byte-order semantics. |
| I | [Zarr indexed-sharding codec](https://zarr-specs.readthedocs.io/en/latest/v3/codecs/sharding-indexed/) | Configuration, Index, Index location, Empty chunks, Encoding and Decoding. |

### 0.2 Rules inherited by reference

The following mechanisms are defined by their upstream sections, rather than restated by chronozarr. Profile choices that restrict their use appear in the later sections.

| Mechanism | Governing upstream section |
|---|---|
| Hierarchy and array/group node semantics | Z, Concepts and terminology / Hierarchy; Stored representation; Metadata. |
| Edge chunk extent and exclusion of elements outside array shape | Z, Chunk grids; Array metadata / shape. The profile's fill-padding choice is in §2.1. |
| Byte order for one-byte element types | B, Configuration / endian. |
| Consolidated discovery and its recommendation | M, Consolidated Metadata. The reader fallback is in §9.2. |
| Six affine coefficients, coefficient ordering and index-to-coordinate corner interpretation | S, spatial:transform / Coordinate convention / Coefficient ordering. North-up and factor-two restrictions are in §§2.3 and 3.3. |
| Shard index representation, index checksums, index placement, empty entries, absent-shard fill and omission of all-fill shards | I, Index, Index location and Empty chunks. Profile interoperability choices are in §7.2. |
| Node metadata representation and naming | Z, Stored representation; Array metadata; Group metadata. |
| Standard shard decoding and array bounds | I, Decoding; Z, Array metadata / shape and Chunk grids. Profile access and missing-data interpretation are in §§4, 7 and 9. |

The regular-grid and default chunk-key-encoding mechanisms are likewise those of Z, Chunk grids and Storage / Chunk key encoding; chronozarr selects the particular choices in §2.1. Compression algorithms and binary representations follow their upstream codec specifications; §7.3 restricts the supported configurations.

### 0.3 Informative reference snapshots

These are the inspected snapshots recorded by the migration plan. They document the source versions inspected; convention registrations instead use the literal URLs required in §3.1. The historical sources below do not impose TileMatrixSet or archived GeoZarr requirements on this profile.

| Source | Inspected immutable snapshot | Date / role |
|---|---|---|
| GeoZarr SWG | [d636b05abbfaa9851d3f12e91335bda22a127243](https://github.com/zarr-developers/geozarr-spec/tree/d636b05abbfaa9851d3f12e91335bda22a127243) | 2026-07-06; informative convention-composition context. |
| Archived OGC draft | [82cba263ff53db4a9ab25366e3e3ed3777ff3f77](https://github.com/zarr-developers/geozarr-spec/tree/82cba263ff53db4a9ab25366e3e3ed3777ff3f77/standard/template) | 2025-12-08; historical `archives-2025` design only. |
| F | [d8077b612759013c0380c4ee562ade2873141da4](https://github.com/zarr-conventions/zarr-conventions-spec/blob/d8077b612759013c0380c4ee562ade2873141da4/README.md) | 2026-06-18; framework. |
| M | [9b78efa75fef0fed302d9cf880037c569354d860](https://github.com/zarr-conventions/multiscales/blob/9b78efa75fef0fed302d9cf880037c569354d860/README.md) | 2026-06-12; v0.1, Pilot. |
| P | [5ca5b2f92e5c7245f957d9128b289ee535f0720d](https://github.com/zarr-conventions/proj/blob/5ca5b2f92e5c7245f957d9128b289ee535f0720d/README.md) | 2026-06-12; v0.1, Pilot. |
| S | [54d81b7ced0376e63ee10f34db31db7d08dcc28d](https://github.com/zarr-conventions/spatial/blob/54d81b7ced0376e63ee10f34db31db7d08dcc28d/README.md) | 2026-06-12; v0.1, Pilot. |
| ndpyramid schema | [bad4c49461fe51cde7e1035a0504ed4d8780efa3](https://github.com/carbonplan/ndpyramid/blob/bad4c49461fe51cde7e1035a0504ed4d8780efa3/docs/schema.md) | 2026-04-06; historical layout comparison. |
| Z / B / I | [ad8fc8df42441c84039c94569980e485e4c09870](https://github.com/zarr-developers/zarr-specs/tree/ad8fc8df42441c84039c94569980e485e4c09870/docs/v3) | 2026-09-21; core and codec sources. |

Pilot conventions may change before stabilizing. A later upstream convention version requires a deliberate profile revision; this draft declares v0.1. Measured reader evidence and its limits are in [the reader spike](../docs/geozarr-profile.md#8-reader-spike): xarray needs an explicit level group; GDAL 3.12.4 needs `_CRS` for CRS assignment; GDAL 3.13.3 assigns the CRS without that alias but exposes the tested pyramid as subdatasets rather than attached overviews. zarr-layer 0.10.0 with zarrita 0.7.5 rendered the true-value fixture and returned its known value at the correct map location. These observations do not establish append, performance or cross-origin hosting conformance for those readers.

### 0.4 Reserved future work

A storage extension for temporal encoding is reserved for future work and is outside this baseline. Such an extension must be fail-closed in unaware readers: an unaware reader MUST reject the extension before returning any encoded data as measurements. No storage-extension syntax, algorithm, registration or decoding mechanism is specified here. The baseline MUST NOT use temporal encoding or require another timestep to decode a data chunk; safely ignorable convention attributes cannot change stored-value interpretation into a storage-decoding operation.

## 1. Scientific and access guarantees

1. **Exact level-0 roundtrip.** A conforming writer followed by a conforming read of level 0 MUST return the exact input stored values in the input dtype. Writers MUST NOT quantize, round or apply lossy compression to level-0 data. Derived overview rounding is specified in §5.
2. **Bounded random access.** Any timestep of any cell at any level MUST require only one data-chunk read after the relevant metadata and, if applicable, shard index are available. There is no sequential timestep dependency. Optional validity/coverage reads are separate plane reads, not additional data chunks.
3. **dtype preservation.** Data MUST be stored and returned in the declared data dtype. The format MUST NOT convert between integer and float or quantize stored data. Physical values are derived at read time (§4.4); they are not substituted into the stored array.
4. **Self-description.** Group and array metadata MUST fully describe layout, bands, timestamps, CRS, geometry, chunk grid, codecs and declared optional planes. A reader MUST NOT need a sidecar or an external metadata service to determine the store's values and geometry.
5. **Ordinary values.** Every data, coordinate and auxiliary array MUST hold its true stored values. Reading with a generic Zarr v3 client that supports the declared codecs yields those values; interpreting physical units and profile validity still requires §§4 and 9.

## 2. Time-series array profile

### 2.1 Levels and data cells

The root MUST contain consecutive level groups named `"0"`, `"1"`, …, with no gaps. Each group MUST contain the data array named by `chronozarr.variable`, coordinate arrays `time`, `band`, `y`, `x`, and any declared optional planes. The data variable name defaults to `"data"`; readers MUST NOT hardcode it. Level 0 is the native grid. Level shapes follow §5.

| Data-array property | Profile restriction |
|---|---|
| Shape and axis order | MUST be `[n_time, n_band, H_k, W_k]`, with positive axis lengths and dimensions `["time", "band", "y", "x"]`. |
| Data dtype | MUST be `uint8`, `uint16`, `int16` or `float32`, identical at every level. |
| Grid / keys | MUST select Z's `regular` grid and `default` chunk-key encoding with separator `/`. |
| Unsharded chunks | MUST have shape `[1, n_band, cs, cs]`; keys are `c/{t}/0/{r}/{c}`. |
| Sharded chunks | MUST use §7.1; the spatial inner chunk size remains `cs`. |
| Fill / nodata attribute | MUST follow §4.1. |
| Codec chain | MUST follow §7.3, inside the indexed-sharding codec when applicable. |

`cs` MUST be a positive even integer, identical at every level, with equal row and column chunk sizes. Writers SHOULD use 256 or 512, with 512 the default; readers MUST accept other positive even sizes, including small test fixtures. Readers MUST derive `cs` from the data array's spatial inner chunk dimensions (indices 2 and 3), using I's inner `chunk_shape` when sharded, and MUST NOT derive it from multiscales metadata or assume 256/512. Every data chunk MUST hold all bands of one timestep of one cell; the band chunk index is 0.

At level `k`, cell `(r,c)` is the spatial slice `[r*cs:(r+1)*cs, c*cs:(c+1)*cs]` for any timestep and band. Row 0 is the north edge. The cell grid MUST equal `[ceil(H_k/cs), ceil(W_k/cs)]`. Elements used as out-of-shape padding by the upstream chunk representation MUST equal the ordinary `fill_value`; edge extent and bounds handling are governed by §0.2, not a separate chronozarr edge-size formula.

### 2.2 Coordinates and dimensions

| Coordinate | Dtype / contents | Requirements |
|---|---|---|
| `time` | `int64`, Unix epoch milliseconds, length `n_time` | MUST be strictly increasing. MUST carry `units: "milliseconds since 1970-01-01T00:00:00"` and `calendar: "proleptic_gregorian"` for native CF datetime interpretation. Monthly, weekly and irregular cadences are permitted. |
| `band` | Zarr `string` with `vlen-utf8`, or `int32`, length `n_band` | MUST contain band names in array order when strings are used; otherwise MUST contain indices `0..n_band-1`. |
| `y` | `float64`, length `H_k` | MUST contain decreasing projected pixel-centre y coordinates in the declared CRS. |
| `x` | `float64`, length `W_k` | MUST contain increasing projected pixel-centre x coordinates in the declared CRS. |

Every array, including coordinates and optional volatility, MUST declare `dimension_names` and `_ARRAY_DIMENSIONS` with identical lists. A coordinate array uses its own one-element dimension list. Each coordinate array SHOULD occupy a single chunk. The time and band coordinate values MUST be identical at every level. Coordinates MUST agree with the canonical spatial metadata (§3.3); x/y describe centres under S's pixel registration.

The ISO timestamp and band-name mirrors MUST agree exactly with their coordinate sources (§3.4). If `band` contains integer indices, `band_names` MUST instead agree with the ordered `bands[].name`; names are not compared to those integer indices. Readers MUST NOT require int64 or variable-length string coordinate reads when valid mirrors supply the needed information.

### 2.3 EPSG north-up grid restriction

All spatial arrays MUST use the same EPSG CRS and north-up affine geometry. Non-EPSG CRSs and rotated grids are outside this profile. In the S coefficient notation, horizontal pixel scale MUST be positive, vertical pixel scale negative, and both rotation/shear coefficients zero. This restricts S's transform without redefining its coefficient ordering or mapping (§0.2).

Writers SHOULD retain the native projected CRS of the AOI, for example its UTM zone. Writers SHOULD NOT reproject storage to Web Mercator: it does not preserve pixel ground area, which affects area-sensitive block means and statistics. The EPSG restriction does not make all EPSG CRSs equal-area. Geometry and mirror agreement follow §3.3.

## 3. chronozarr attributes and mirrors

### 3.1 Convention registration and root metadata

The root MUST declare `chronozarr` and M in `attributes.zarr_conventions`, using F's Convention Metadata Objects. Every data, mask and coverage array MUST explicitly declare P and S on that array, rather than depend on inheritance for profile conformance. Coordinate arrays and ungeoreferenced volatility MUST NOT declare S. Other registrations MAY appear only when their conventions apply without changing the baseline's ordinary stored values.

Each M/P/S registration MUST contain the following UUID, name and **literal** schema/spec URL pair. Commit-based URLs MUST NOT be emitted in these registrations. The convention snapshot identities in §0.3 MUST NOT be emitted as store metadata. F's allowed registration fields and semantics apply by reference; no snapshot or extra version field is added to the registration object.

| Name | UUID | `schema_url` | `spec_url` |
|---|---|---|---|
| `multiscales` | `d35379db-88df-4056-af3a-620245f8e347` | `https://raw.githubusercontent.com/zarr-conventions/multiscales/refs/tags/v0.1/schema.json` | `https://github.com/zarr-conventions/multiscales/blob/v0.1/README.md` |
| `proj` | `f17cb550-5864-4468-aeb7-f3180cfb622f` | `https://raw.githubusercontent.com/zarr-conventions/proj/refs/tags/v0.1/schema.json` | `https://github.com/zarr-conventions/proj/blob/v0.1/README.md` |
| `spatial` | `689b58e2-cf7b-45e0-9fff-9cfc0883d6b4` | `https://raw.githubusercontent.com/zarr-conventions/spatial/refs/tags/v0.1/schema.json` | `https://github.com/zarr-conventions/spatial/blob/v0.1/README.md` |

The root chronozarr registration MUST contain `name: "chronozarr"` and `spec_url: "https://github.com/chronozarr/chronozarr/blob/main/spec/CHRONOZARR.md"`. Its profile version is recorded in the `chronozarr` block, not as a Convention Metadata Object field. This draft assigns no chronozarr UUID or schema URL.

The root MUST carry a `chronozarr` object (§3.2) and a `multiscales` object conforming to M (§3.3). Consolidated metadata and its recommendation follow M, Consolidated Metadata (§0.2); readers MUST retain the nonconsolidated fallback in §9.2.

### 3.2 `chronozarr` block

| Field | Type | Profile rule |
|---|---|---|
| `spec_version` | string | Writers MUST write exactly `"0.3.0"`. Readers MUST reject every other value, including missing values, before returning data, with a message directing the user to `chronozarr convert` (§9.1). |
| `variable` | string | Data-array name inside each level, default `"data"`; MUST be declared by writers. |
| `times` | string[] | MUST be written, length `n_time`; each entry MUST be the ISO-8601 rendering of the corresponding time coordinate. |
| `bands` | object[] | MUST be written, length `n_band`; object-only band descriptions, §4.4. |
| `band_names` | string[] | Writers MUST write the ordered `bands[].name`. Readers finding only `bands` MUST derive the names rather than read the band coordinate. |
| `nodata` | number or null | MUST be declared; §4.1. |
| `crs` | string | MUST be an `EPSG:<code>` mirror equal to canonical P metadata on every spatial array. |
| `levels` | object[] | Writers MUST write the ordered mirrors in §3.4. Readers MUST support their absence through §9.2. |
| `mask_variable` | string | MUST equal `"mask"` iff masks are present at every level; otherwise MUST be absent. |
| `coverage_variable` | string | MUST equal `"coverage"` iff coverage is present at every level; otherwise MUST be absent. |
| `volatility_path` | string | MAY be present; MUST equal `"volatility"` iff the optional root volatility array is present (§6). Otherwise MUST be absent. |
| `provenance` | object | MAY be present; §4.5. |
| `shard_bytes` | object | MAY be present only for sharded stores; §7.2. |

No temporal-encoding fields are part of this block. The baseline MUST NOT use attributes to reinterpret ordinary chunks as encoded measurements.

### 3.3 Multiscales and authoritative geometry

`multiscales` MUST use M's object form with `layout`. Its entries MUST be ordered by consecutive level groups `"0"`, `"1"`, …; each `asset` MUST be the group path, not a data-array path. Each level after 0 MUST declare `derived_from` equal to the preceding group and a relative transform with `scale: [2,2]` and `translation: [0,0]`, under M's Transform Object. `resampling_method` MUST be `"average"`; exact average semantics are chronozarr rules in §5. The base entry MAY carry the identity relative transform. Legacy list/datasets metadata and tile-size hints MUST NOT be written or used for v0.3 discovery.

Informative example of a two-level object:

```json
{
  "multiscales": {
    "layout": [
      {"asset": "0"},
      {"asset": "1", "derived_from": "0", "transform": {"scale": [2, 2], "translation": [0, 0]}}
    ],
    "resampling_method": "average"
  }
}
```

Every spatial array MUST carry `proj:code: "EPSG:<code>"`, `spatial:dimensions: ["y","x"]`, `spatial:transform` and `spatial:registration: "pixel"`, and satisfy P/S. If `spatial:transform_type` is supplied it MUST be `"affine"`. Writers SHOULD also supply matching `proj:wkt2`. Optional `proj:projjson`, when supplied, MUST describe the same CRS. Optional `spatial:shape` MUST equal `[H_k,W_k]`; optional `spatial:bbox` MUST agree with the array's shape and S geometry. Equivalent properties supplied on M layout entries MUST agree with the spatial arrays. P/S are the authoritative CRS and geometry sources; chronozarr mirrors MUST NOT override them.

Level `k` MUST have the same origin as level 0 and both pixel scales multiplied by `2^k`; all spatial arrays in a level MUST agree geometrically. Each level group MUST retain `crs`, `transform` and `resolution` mirrors. `crs` MUST equal `proj:code`; `transform` MUST equal the canonical S coefficient list without introducing another mapping; `resolution` MUST equal the positive horizontal ground sample distance at that level. Group and root mirrors MUST be validated against canonical array metadata.

Spatial arrays MAY repeat `crs` and `transform` aliases, but these MUST agree with P/S when present, and readers MUST NOT require them. Writers SHOULD emit `_CRS` on data/mask/coverage for GDAL versions below 3.13, with `{"url":"http://www.opengis.net/def/crs/EPSG/0/<code>"}` and an optional matching string `wkt`. Readers MUST NOT require `_CRS`; if present it MUST agree with `proj:code`. The reader spike found that GDAL 3.13.3 recognizes the canonical CRS without this alias, but its native subdataset/overview discovery is not the chronozarr reader contract (§9).

### 3.4 Mirrors and validation

Readers MUST use the available `times`, `band_names` and `levels` mirrors as primary request-saving sources and MUST NOT require coordinate-array reads to obtain the same information. A validator MUST check mirror/source agreement. Disagreement is an error, not permission to silently replace authoritative P/S metadata.

`times[i]` MUST render the exact epoch-ms coordinate value; `band_names[i]` MUST equal `bands[i].name` and, for string band coordinates, `band[i]`. The levels mirror MUST contain one entry per M layout entry, in the same order:

| Field | Type | Equality rule |
|---|---|---|
| `path` | string | MUST equal the corresponding `multiscales.layout[].asset` group path. |
| `resolution` | number | MUST equal the level group value and canonical horizontal pixel scale. |
| `transform` | number[6] | MUST equal the level-group mirror and canonical S transform. |
| `shape` | integer[4] | MUST equal the data array shape `[n_time,n_band,H_k,W_k]`. |
| `grid` | integer[2] | MUST equal `[ceil(H_k/cs),ceil(W_k/cs)]`. |

Writers MUST emit the mirrors specified above. Their reader fallbacks in §§3.2 and 9.2 support discovery of baseline values without inventing a legacy parser. A validator MUST distinguish a missing required writer field from a decodable fallback path.

## 4. Validity, units and provenance

### 4.1 Dtype, nodata and fill

| Data dtype | Allowed `nodata` | Writer default | Overview arithmetic |
|---|---|---|---|
| `uint8` | Integer 0–255, or null | 0 | Integer (§5). |
| `uint16` | Integer 0–65535, or null | 0 | Integer (§5). |
| `int16` | Representable integer, or null | null | Integer (§5). |
| `float32` | Finite representable number, or null | null | Float (§5). |

`chronozarr.nodata` MUST be one number or null. Null declares no nodata sentinel. If it is a number, it MUST equal each data array's `fill_value` and `nodata` attribute. If it is null, `fill_value` MUST be 0 and the data array's `nodata` attribute MUST be absent. NaN MUST NOT be used as nodata. Writers SHOULD NOT store NaN data; gaps SHOULD be marked using the sentinel or mask.

A pixel is valid when its mask exists and equals 1; otherwise, if there is no mask and a numeric nodata sentinel exists, when its data value differs from that sentinel; otherwise it is valid. A reader with a mask MUST use it and MUST NOT also compare data to the nodata sentinel. Invalid pixels MUST be treated as missing in band math, statistics, block means and charts. Where mask equals 0 the data value is not interpreted, and writers SHOULD store `fill_value` there. A missing optional mask does not make the store invalid; it changes which of these validity rules applies.

### 4.2 Mask

A writer MAY supply `{level}/mask`, but MUST supply it at every level or at none. The root declaration follows §3.2. Every mask MUST contain true `uint8` values 0 (invalid) or 1 (valid), with shape `[n_time,H_k,W_k]`, dimensions `["time","y","x"]`, matching `_ARRAY_DIMENSIONS`, and `fill_value: 0`.

Mask chunks MUST follow the data layout without the band axis: unsharded `[1,cs,cs]`, keys `c/{t}/{r}/{c}`; sharded `[shard_time,cs,cs]` with inner chunks `[1,cs,cs]`, keys `c/{ts}/{r}/{c}`. The declared spatial metadata and codec chain MUST follow §§3.3 and 7. A coarser mask MUST be the maximum over each padded 2×2 source block (1 if any source pixel is valid), with edge replication as in §5.

### 4.3 Coverage

A writer MAY supply `{level}/coverage`, but MUST supply it at every level or at none. Its declaration follows §3.2. Every coverage array MUST use `uint8`, shape `[n_time,H_k,W_k]`, dimensions `["time","y","x"]`, matching `_ARRAY_DIMENSIONS`, and `fill_value: 0`. Its layout, chunk sizes, keys, spatial metadata and codec chain MUST match the mask rules, whether or not a mask exists.

Level-0 coverage MUST represent the number of valid observations behind a pixel, saturated at 255. Zero denotes a pixel that was gap-filled or never observed. At a coarser level it MUST be the mean of the four edge-replicated source values, rounded to nearest integer with halves up: `(sum + 2) // 4`. Coarser values are rounded summaries, not literal independent observation counts. Coverage MUST NOT replace the mask or sentinel validity rule: a gap-filled pixel can be valid with coverage 0. Gap-fill provenance follows §4.5.

### 4.4 Band descriptions and physical values

Each `chronozarr.bands` entry MUST be an object. String-only descriptions and source-specific scale inference are outside this profile.

| Field | Type | Rule |
|---|---|---|
| `name` | string | MUST be unique within the store and equal the string coordinate value where band coordinates hold names. |
| `common_name` | string | MAY be supplied; SHOULD use the applicable STAC `eo:bands` vocabulary, e.g. red, green, blue, nir, swir16 or swir22. |
| `scale` | number | MAY be supplied; default 1. Writers SHOULD write it explicitly. |
| `offset` | number | MAY be supplied; default 0. Writers SHOULD write it explicitly. |
| `units` | string | MAY be supplied; free text, e.g. `"reflectance"` or `"fraction"`. |

Physical value is `stored * scale + offset`. Consumers MUST apply that formula whenever valid physical values are shown or combined; invalid pixels MUST remain missing and MUST NOT be scaled into valid measurements. Consumers doing band math or indices SHOULD select by `common_name`, falling back to `name`, and MUST NOT assume a source's reflectance scale. An RGB uint8 band with scale 1 is interpreted in its stored units.

Writers MUST NOT set CF `scale_factor` or `add_offset` on data arrays to silently trigger automatic scaling by generic clients. Generic readers see stored values; conversion to physical units is an explicit consumer operation. The CF time units in §2.2 are independent of this band-value rule.

### 4.5 Provenance

A writer MAY supply `chronozarr.provenance`. When present it MUST contain:

| Field | Type | Rule |
|---|---|---|
| `sources` | string[] | Required; collection identifiers or input-data URLs. |
| `composite` | string | Required; temporal-composite description, e.g. `"monthly median"`. |
| `gap_fill` | string | Required; `"none"` or `"carry-forward"`. Carry-forward means a pixel with no valid observation takes the previous timestep's value. |
| `notes` | string | Optional additional explanation. |

Provenance MUST describe the processing actually applied. It does not override validity or coverage interpretation.

## 5. Overview semantics

Level 0 MUST retain native-resolution stored values. Each level `k>0` MUST be derived from level `k-1` by a factor-two block mean of true values, excluding invalid pixels under §4.1. A block with no valid pixels MUST produce the declared nodata value, or 0 if nodata is null.

Before reduction, the source MUST be padded to an even height and width by edge replication, including the validity and coverage planes. Thus `H_k = ceil(H_{k-1}/2) = ceil(H_0/2^k)` and similarly for width. The origin MUST remain fixed and ground sample distance MUST double at each level (§3.3).

For uint8, uint16 and int16, writers MUST compute the exact sum in a wider integer type (uint32 or int32 as appropriate), divide by the valid-pixel count using floor division, and store the result in the unchanged data dtype. Float32 means MUST accumulate in float64 and be stored as float32. Masks and coverage MUST reduce as in §§4.2–4.3. No other overview resampling method is part of this profile.

The spatial chunk size MUST stay constant; only array shape and cell grid shrink. Levels MUST be consecutive from 0. The default writer MUST stop at the first level whose cell grid is 1×1, including that level; a writer MAY explicitly choose fewer or more levels.

**Categorical and binary guidance.** Integer block means do not preserve categorical classes or binary shares: a 2×2 block with three integer 1s and one 0 becomes 0 under floor division. A binary quantity SHOULD be stored as a scaled fraction, e.g. 0/10000 with scale 1e-4 and units `"fraction"`, so the coarse stored value represents the flagged share. Class codes have no meaningful arithmetic mean. A writer requiring majority/nearest categorical overviews must prepare a separately described product; it MUST NOT advertise such a pyramid as this profile's average pyramid. The default mean and its limitations MUST NOT be silently replaced by a categorical rule.

## 6. Volatility

A store MAY include the root array `volatility`, declared only through `chronozarr.volatility_path`. Its absence is conforming and MUST NOT prevent decoding or scientific interpretation of data. When present, it MUST use true float32 values, shape `[grid_rows_0,grid_cols_0]`, dimensions `["row","col"]` with matching `_ARRAY_DIMENSIONS`, and one chunk covering that shape. It is a cell-ordering metric, not a georeferenced pixel array, and MUST NOT declare S.

The existing nominal comparison policy is retained solely for this metric. The publisher chooses a positive integer comparison interval `s`, default 6. Let `C={0,s,2s,…}` restricted to indices below `n_time`; let `D` be the other timestep indices. For each `t` in D, `q(t)` is the closest index in C by absolute index distance, with ties toward the earlier index. The comparison policy is independent of storage, is not a decoding instruction, and need not be recorded. Readers MUST NOT require it to decode data or use the stored metric for ordering.

```text
volatility[r,c] = clip(
    mean(abs(source[t] - source[q(t)])
         over t in D, all bands and all source pixels of level-0 cell (r,c)) / 10000,
    0, 1)
```

When written, this value MUST be computed from exact differences: int32 for integer data and float64 for float32 data. The mean MUST include invalid source pixels, as in the existing publisher metric, and MUST use level 0 only. It MUST be 0 if D is empty, including `s=1` or `n_time=1`; an all-zero mean likewise yields 0. Results MUST be clipped to [0,1] and stored as float32. The divisor 10000 is fixed for every dtype; it reflects the original reflectance normalization and is not a physical unit. For other sources it remains a relative temporal-change metric, not a calibrated change magnitude.

Readers MAY use volatility to order prefetch or draw change overviews. They MUST distinguish optional metric availability from data decodability. A present array that violates this definition is a conformance error, whereas an absent array is not.

## 7. Storage interoperability restrictions

### 7.1 Unsharded default and optional time sharding

Writers MUST default to unsharded data, mask and coverage arrays. A writer MAY explicitly choose indexed time sharding. Readers MUST support both forms and determine the form from the codecs, not a filename assumption. Unsharded objects and cells follow §§2.1 and 4; a timestep of a cell costs one object GET and no index read.

A sharded data array MUST select `sharding_indexed` with shard shape `[shard_time,n_band,cs,cs]` and inner shape `[1,n_band,cs,cs]`. Mask and coverage shard shapes MUST be `[shard_time,cs,cs]`, inner shapes `[1,cs,cs]`, using the same positive integer `shard_time`. Sharding index and empty-chunk semantics are inherited from I (§0.2).

`shard_time` MUST be an integer at least 1. When sharding is explicitly chosen, the default `shard_time` is `n_time` at creation. It MAY exceed `n_time`; partial time shards follow I. The number of time shards is `ceil(n_time/shard_time)`. Readers MUST handle multiple time shards. A writer MUST NOT accept a `shard_time` option without enabling sharding.

Timestep `t` belongs to time shard `ts=floor(t/shard_time)` at inner timestep `t mod shard_time`. The data shard key is `c/{ts}/0/{r}/{c}`, and the plane key is `c/{ts}/{r}/{c}`. There is one shard object per time shard and spatial cell per level and variable; the data band grid remains one. Readers MUST derive the shapes and mapping from the regular grid and I configuration.

A writer SHOULD choose `shard_time` so no object exceeds the intended host/CDN cache or range-serving limit, and a whole-object miss is tolerable. A CDN may retrieve a whole large shard for a small index range. For appendable stores, unsharded storage SHOULD be used; if object count justifies sharding, writers SHOULD choose a finite interval, e.g. 12 for monthly data, instead of automatically using an entire long archive. Whole-axis sharding is appropriate for archives that will not be appended. An append rewrites the shard receiving new timesteps (§8.3).

### 7.2 Index access, cache and byte-length hints

The index representation, checksum, placement semantics and missing/empty chunk rules are those of I, Index / Index location / Empty chunks (§0.2). Writers SHOULD use `index_location: "end"` for tested browser interoperability. Readers MUST support both upstream index locations, MUST cache indices per shard and MUST reuse one array handle per level rather than defeat an implementation's per-array index cache.

`chronozarr.shard_bytes` MAY inventory existing data-array shard objects (not mask/coverage), using:

```text
{ "<level group path>": { "<t_shard>/<row>/<col>": <exact object byte length> } }
```

When supplied, the inventory MUST list exactly the data shards that exist at every level, with exact lengths for the published metadata snapshot. A reader MUST use a listed length for a bounded index range and MUST fall back to HEAD to learn the length of an unlisted shard. Given object length L and index length N determined under I, an end-index bounded request is `Range: bytes=(L-N)-(L-1)`. Without a listed length, suffix-range access or the HEAD fallback follows the host's capabilities; the required HEAD fallback MUST remain available. Missing objects follow I's empty-chunk rules, not an invented sentinel representation.

Lengths MUST be updated when append rewrites an object; they are not universally immutable. An unchanged shard retains its length. Snapshot recovery for a replaced trailing shard is specified in §8.4.

### 7.3 Codec subset

Codec algorithms, configuration semantics and binary representations follow [bytes](https://zarr-specs.readthedocs.io/en/latest/v3/codecs/bytes/), [zstd](https://zarr-specs.readthedocs.io/en/latest/v3/codecs/zstd/), [gzip](https://zarr-specs.readthedocs.io/en/latest/v3/codecs/gzip/) and [blosc](https://zarr-specs.readthedocs.io/en/latest/v3/codecs/blosc/). This profile restricts the choices:

| Compressor | Profile configuration |
|---|---|
| `zstd` | Default: level 5, checksum false. |
| `blosc` | `cname` MUST be zstd or lz4; `shuffle` MUST be noshuffle or shuffle; `clevel` MUST be 0–9; `typesize` MUST equal the array element size in bytes; `blocksize` MUST be 0. |
| `gzip` | Level MUST be 1–9. |

Readers MUST support all three compressors, including both allowed blosc compression and shuffle variants. Writers MUST use exactly one supported compressor preceded by the bytes codec with little-endian configuration for numeric arrays; byte-order exceptions for one-byte dtypes follow B (§0.2). For string band coordinates, the standard Zarr `vlen-utf8` array-to-bytes codec replaces numeric bytes serialization, followed by a supported compressor. This required string representation is not another permitted numeric compressor.

Other compression codecs, other blosc `cname` values, and `shuffle: "bitshuffle"` MUST NOT be used. The data, mask and coverage arrays MUST use the same codec chain, apart from element-size/byte-order differences required by their dtypes and the surrounding sharding configuration. Coordinates and optional volatility MAY independently choose any of the three supported compressors. Readers MUST report unsupported data types or codecs by name (§9.2).

## 8. Static publishing and append

### 8.1 HTTP host contract

Stores are served as objects by key from a static host; no application server is required. Z's node metadata representation applies by reference (§0.2).

| Host behavior | Requirement |
|---|---|
| GET of an existing key returns its object bytes; an absent key returns 404, not a 200 fallback page | MUST. |
| Range requests return 206 Partial Content with Content-Range | MUST for sharded stores; unsharded stores require only GET. |
| Chunk/shard bytes are served unchanged, with no Content-Encoding or other transformation | MUST. |
| `Access-Control-Allow-Origin: *` | MUST. |
| `Access-Control-Allow-Headers: Range` or `*`, and OPTIONS preflight answers 200/204 | SHOULD. |
| `Access-Control-Expose-Headers: Content-Range, Content-Length` | SHOULD. |
| `Cache-Control: public, max-age=31536000, immutable` on immutable objects | SHOULD; mutable append objects use §8.3. |
| `Timing-Allow-Origin: *` | MAY. |

Bounded ranges avoid the suffix-range CORS preflight on tested browsers. Cross-origin transfer-size measurement without Timing-Allow-Origin may report zero, so consumers can use exposed Content-Length for byte accounting. Directory listing MUST NOT be required; consumers MUST derive keys from metadata and MUST NOT depend on object content types.

### 8.2 Immutable publication

A re-encode MUST be written under a new prefix, never over an existing published store. The only permitted in-place growth is append under §§8.3–8.4, preserving old values.

Initial upload order SHOULD be data/plane chunks and shards first, then metadata below the root, and root metadata last. The reader uses root metadata as the publication marker. Metadata-last publication does not make a multi-object update atomic and does not excuse incomplete working-copy validation.

### 8.3 Append restrictions and writes

A store MAY grow only at the end of its time axis. New dates MUST be strictly after the previous final date, and MUST have compatible grid, bands (including units/scales/offsets), dtype, CRS and nodata. A store with a mask or coverage MUST receive that plane for every new timestep; a store without the plane MUST NOT acquire it through append. Existing grid geometry, level count, cell size, layout and codec configuration MUST remain compatible.

The writer MUST construct an append in a working copy and validate it before publication. It MUST extend every level's data and declared mask/coverage shapes to the new `n_time`, rewrite the time coordinate as a single chunk of the new length, update `chronozarr.times`, `levels[].shape`, affected `shard_bytes`, array shapes and consolidated metadata when present. Optional volatility, if present, MUST be updated to satisfy §6 over the enlarged series; its absence does not require adding it. Each new overview timestep MUST be derived by the same §5 rules as a fresh encode. M layout and fixed geometry remain unchanged.

Unsharded append MUST write only new timestep chunk objects and the mutable metadata/coordinates/optional metric. With sharding, only shards receiving new timesteps MAY be replaced: the previously partial trailing shard and any newly created time shards. Earlier completed shards MUST remain byte-identical. A replaced trailing shard MUST retain byte-identical encoded chunks and unchanged decoded values for all existing timesteps, although I does not promise identical offsets in a rewritten object.

Every existing unsharded data/mask/coverage chunk MUST remain byte-identical. All old band, x and y coordinate values and objects, level geometry, and M layout MUST remain unchanged. The existing prefix of the time coordinate MUST remain unchanged in value even though its single chunk is rewritten. No previously published data or validity meaning may change.

Objects that MAY change in place are root and descendant node metadata, each level's time-coordinate chunk, optional volatility, and previously partial trailing shards. All other existing chunk/shard objects MUST remain immutable. Hosts SHOULD give mutable objects short cache lifetimes. Append publication SHOULD upload new/replacement chunks and shards first, then time-coordinate chunks and optional volatility, then descendant metadata, and finally root metadata. Metadata-last ordering does not provide atomicity or automatic rollback; the working copy and validation are required.

### 8.4 Reader snapshots and stale-index recovery

A reader holding a previous root metadata snapshot MUST continue to interpret its listed timesteps with the previous shapes and compatible geometry. It MUST reload root metadata to discover new timesteps. Preservation of old bytes and values is required; preservation of offsets by a particular writer is not a universal guarantee.

For a mutable trailing shard, a reader MUST NOT blindly apply cached offsets from an old shard version to replacement bytes. A reader detecting a version/length mismatch, invalid index, failed index checksum or incompatible chunk read MUST discard the affected index, refresh metadata/length information and refetch the current index before retrying. Readers MUST keep array shapes consistent with their selected metadata snapshot; older listed timesteps remain readable from the updated shard's index. A stale listed length can put an end-index range at the wrong byte location. Reloading root/array metadata and obtaining the current object length are the recovery path. Once a subsequent shard begins, the previously completed shard MUST remain unchanged. Unsharded stores have no index-replacement hazard.

## 9. Consumer contract

### 9.1 Profile and version rejection

A conforming reader MUST first GET `{store}/zarr.json` (or open the equivalent local root metadata) and check `attributes.chronozarr.spec_version`. It MUST accept exactly `"0.3.0"` and MUST reject any other or missing value before producing data. The error MUST name the unsupported/missing version and direct the user to `chronozarr convert`, for example: `Unsupported chronozarr spec_version 0.2.0; convert the store with chronozarr convert before opening it with a v0.3 reader.`

v0.2 stores are converted, not read by v0.3 readers. There is no dual-version parser, automatic URL fallback, legacy band-string scale inference or legacy multiscales-list path. The conversion operation is outside the normal reader contract and this draft does not claim its implementation is already available.

Readers MUST enforce the ordinary-value baseline and inherited Z extension rules before returning measurements. Mandatory-extension handling is inherited from Z, Extensions; this profile does not substitute an ignorable attribute flag for that mechanism.

### 9.2 Metadata discovery and fallback

Readers MUST take timestamps from `chronozarr.times`, band objects from `chronozarr.bands`, the variable name from `chronozarr.variable`, and validity inputs from `nodata`, `mask_variable` and `coverage_variable`. They MUST use band-name and level mirrors when present (§3.4), deriving missing `band_names` from the band objects.

When `levels` is absent, readers MUST enumerate M's ordered `layout[].asset` groups and obtain canonical P/S geometry plus data shape/chunk/codec metadata at each level. Readers MUST use available consolidated metadata for those properties and MUST fall back to individual group/array node metadata when consolidation is absent. They MUST derive `cs` from inner chunks (§2.1), report any unsupported `data_type` or codec by name, and reject metadata contradictions rather than invent a geometry override. Mirrors avoid mandatory coordinate-array reads; validation MAY read their sources to test agreement.

A generic client is not automatically a conforming chronozarr reader. Informative examples: `xarray.open_zarr(store, group="0")` opens a selected level with ordinary stored values; root `open_zarr` may be an empty dataset. GDAL subdataset enumeration is not proof that it attaches overview levels or applies a separate mask. These behaviors do not relax the contract for a chronozarr-aware consumer.

### 9.3 Level, value and plane access

Readers MUST select the largest level index `k` whose `resolution` does not exceed the requested output ground sample distance, or `k=0` if none qualifies. For a requested timestep and spatial cell they MUST read one ordinary data chunk using §§2 and 7, with the standard I decoding and Z bounds rules inherited in §0.2. They MUST NOT require another timestep's chunk to obtain that value.

Readers MUST apply §4.1 validity in math, statistics and charts, and §4.4 scale/offset wherever physical values are shown or combined. They MUST read mask or coverage planes only when their corresponding declarations are present, and MUST NOT treat coverage as a validity substitute. Optional volatility MUST NOT be required for opening or reading data.

Readers SHOULD cache decoded data chunks for the session and SHOULD prefetch ordinary frames to reduce interaction latency. They MUST retain the per-shard index cache and array-handle reuse rules in §7.2, while recovering correctly for mutable trailing shards (§8.4). Consolidated root discovery and mirrors preserve a single-root-request metadata path; the format does not promise a particular network latency or that every generic reader uses that path.

## 10. Changes from 0.2

This table is informative. It lists the removals and changes; retained chronozarr requirements are normative in §§1–9. v0.2 stores require explicit conversion and are not baseline v0.3 reader inputs.

| v0.2 rule or surface | Removal / change in v0.3.0 | New section / authority |
|---|---|---|
| Version `0.2.x`, acceptance of `0.1.x` and `0.2.x` | Exact `0.3.0` draft version; every other or missing value rejected with `chronozarr convert` guidance. No automatic legacy fallback. | §§3.2, 9.1. |
| Two temporal storage modes and required support for both | Removed; every array holds ordinary true values. No temporal mode declaration or mode-dependent dtype eligibility. | §§0.4, 1, 4.1. |
| Star-delta anchors, anchor interval/indices, reference map and reference-distance rules | Removed entirely from baseline storage and reader requirements. | §§0.4, 1, 9.3. |
| Modular residual representation, reconstruction, clamp/overflow policy and residual-specific nodata handling | Removed; only standard Zarr codec decoding remains. | §§1, 4.1, 9.3; Z/I. |
| Residual-zero edge padding versus anchor fill | Removed; ordinary fill padding applies, with edge geometry/bounds inherited. | §2.1; Z, Chunk grids / shape. |
| Temporal auto/none/star-delta writer selection, sample ratio/threshold and selection metadata | Removed; no temporal selection API or metadata is specified. | §§0.4, 3.2. |
| Cross-shard temporal dependencies and two-data-chunk bound | Removed; one data chunk per timestep/cell after metadata/index discovery. | §§1, 7, 9.3. |
| Anchor-multiple shard sizing and anchor-first prefetch/caches | Removed; sizing is based on host/append limits and caches/prefetch use ordinary chunks. | §§7.1–7.2, 9.3. |
| Append additions to temporal maps, fixed references and reuse of earlier anchors | Removed; append extends ordinary values and preserves old chunks/values. | §8.3. |
| Zarr hierarchy and leaf-node restatement | Replaced by upstream reference. | §0.2; Z, Hierarchy / Metadata. |
| Edge chunk extent and array-bound trimming restatement | Replaced by upstream reference; fill-padding policy retained. | §§0.2, 2.1; Z, Chunk grids / shape. |
| One-byte bytes-codec endian exception restatement | Replaced by upstream reference; numeric little-endian profile retained. | §§0.2, 7.3; B. |
| Local consolidated-metadata recommendation | Replaced by M reference; nonconsolidated reader fallback retained. | §§0.2, 9.2; M, Consolidated Metadata. |
| Local six-coefficient affine definition and corner formula | Replaced by S reference; north-up/factor-two/same-origin restrictions retained. | §§0.2, 2.3, 3.3; S. |
| Shard index uint64 pairs, CRC layout, sentinel values, index-location/empty-shard semantics | Replaced by I reference; both-location support, end-location advice, cache and length hints retained. | §§0.2, 7.2; I. |
| Node metadata naming versus v2 dotfiles | Replaced by Z reference. | §§0.2, 8.1; Z, Metadata. |
| Standard shard decoding and array bounds in the reader algorithm | Replaced by I/Z reference; profile access/validity rules retained. | §§0.2, 9.3; I/Z. |
| ndpyramid list, datasets, type and metadata.method/version/args fields | Replaced by M object layout, asset, derived_from, relative transforms and declared average resampling. | §3.3; M. |
| `pixels_per_tile` emission/ignore/legacy acceptance rules | Removed; no legacy tile-size hint or parser. Cell size is derived from inner chunks. | §§2.1, 3.3, 9.1. |
| Implicit convention composition | Explicit root chronozarr/M and spatial-array P/S registrations with literal v0.1 URLs. Snapshots recorded only as informative references. | §§0.3, 3.1. |
| Optional proj/spatial aliases and nonrequirement | Canonical array P/S metadata and registrations required; EPSG `proj:code`, affine geometry and explicit pixel registration required. | §§2.3, 3.3. |
| EPSG/native CRS mirrors interpreted as authorities | EPSG north-up scope fixed; P/S authoritative, mirrors validated against them; rotated/non-EPSG grids excluded. | §§2.3, 3.3–3.4. |
| `_CRS` compatibility alias | Writers SHOULD emit it for GDAL below 3.13; not a v0.3 reader requirement. Reader observations distinguish CRS assignment from overview attachment. | §§0.3, 3.3. |
| Levels mirrors tied to legacy datasets paths | Paths now match M layout assets; geometry equality uses canonical S and Z shape. | §3.4. |
| String-only bands and implicit source-specific physical scaling | Removed; object-only bands, explicit scale/offset advice and consumer physical-value rules retained. | §§4.4, 9.1. |
| Mandatory volatility, and its dependence on temporal encoding | Volatility MAY be absent; when present the existing exact-difference/normalization metric uses a nominal comparison policy independent of storage. | §6. |
| Overview reduction followed by temporal encoding | Removed encoding stage; true-value block means, validity, edge replication and rounding retained. | §5. |
| Claims that all shard lengths are immutable | Lengths describe a snapshot and MUST change with rewritten append objects; HEAD/recovery retained. | §§7.2, 8.4. |
| Assumption that a writer keeps old shard chunk offsets | No universal offset guarantee; old encoded chunk bytes/decoded values preserved, cached index must be refreshed for changed shards. | §§8.3–8.4. |
| Metadata-last publication described as sufficient to prevent missing-data views | Publication order retained with explicit non-atomicity and working-copy validation. | §§8.2–8.4. |
| Append always updates volatility | Update only when volatility exists; absence remains conforming. | §§6, 8.3. |
| Sections 0–14 and “Changes from 0.1” history | Reorganized as sections 0–9 plus this table; old change file is a pointer to this section. Historical implementation/prior-art prose is not a baseline conformance rule. | §10. |
| Reference implementations described as current spec implementations | This is a draft; observed generic-reader capabilities are informative, not a claim that existing chronozarr code implements v0.3.0. | §§0, 0.3, 9.2. |
