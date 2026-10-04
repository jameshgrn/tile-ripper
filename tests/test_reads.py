"""Reader behaviour: chunk-read counts, edge cells, padding, bounds, decode guard."""

from __future__ import annotations

import numpy as np
import pytest
from numcodecs import Zstd
from zarr.abc.store import ByteRequest, SuffixByteRequest
from zarr.storage import LocalStore, WrapperStore

import chronozarr
from chronozarr import schema
from tests.synthetic import build_store, make_truth

pytestmark = pytest.mark.unit

N_TIME, N_BAND, HEIGHT, WIDTH = 3, 2, 700, 600
INDEX_BYTES = 16 * N_TIME + 4  # shard index: (offset, nbytes) uint64 pairs + crc32c


class CountingStore(WrapperStore):
    """Records every read of the store: (key, byte range)."""

    def __init__(self, store):
        super().__init__(store)
        self.reads: list[tuple[str, ByteRequest | None]] = []

    async def get(self, key, prototype, byte_range=None):
        self.reads.append((key, byte_range))
        return await super().get(key, prototype, byte_range)

    async def get_partial_values(self, prototype, key_ranges):
        self.reads.extend(key_ranges)
        return await super().get_partial_values(prototype, key_ranges)

    async def get_ranges(self, key, byte_ranges, *, prototype, **options):
        # zarr >= 3.4 reads a shard's inner chunks through get_ranges, which WrapperStore
        # forwards to the inner store, bypassing get(). Record one read per requested range
        # (coalescing below this layer does not change what a reader logically asked for).
        self.reads.extend((key, byte_range) for byte_range in byte_ranges)
        async for batch in super().get_ranges(key, byte_ranges, prototype=prototype, **options):
            yield batch

    def data_reads(self) -> list[tuple[str, ByteRequest | None]]:
        return [r for r in self.reads if r[0].startswith("0/data/c/")]


@pytest.fixture(scope="module", params=[True, False], ids=["sharded", "unsharded"])
def synthetic(request, tmp_path_factory):
    truth = make_truth(N_TIME, N_BAND, HEIGHT, WIDTH)
    path = tmp_path_factory.mktemp("reads") / "store"
    build_store(path, truth, shard=request.param)
    return path, truth, request.param


def _counted(path):
    counting = CountingStore(LocalStore(path, read_only=True))
    store = chronozarr.open_store(counting)
    counting.reads.clear()
    return store, counting


def test_every_timestep_reads_one_chunk(synthetic):
    path, _, sharded = synthetic
    for t in range(N_TIME):
        store, counting = _counted(path)
        store.read_cell(t, 0, 0)
        reads = counting.data_reads()
        assert len(reads) - (1 if sharded else 0) == 1


def test_full_timestep_touches_only_its_own_chunks(synthetic):
    path, truth, sharded = synthetic
    store, counting = _counted(path)
    assert np.array_equal(store.read(1), truth[1])
    reads = counting.data_reads()
    if sharded:
        indices = [r for r in reads if r[1] == SuffixByteRequest(INDEX_BYTES)]
        assert len(indices) == 4
        assert len(reads) - len(indices) == 4
    else:
        assert {int(key.split("/")[3]) for key, _ in reads} == {1}
        assert len(reads) == 4


def test_edge_cells_have_exact_shape_and_values(synthetic):
    path, truth, _ = synthetic
    store = chronozarr.open_store(path)
    for t in range(N_TIME):
        for row, col in [(0, 0), (0, 1), (1, 0), (1, 1)]:
            ys = slice(row * 512, min((row + 1) * 512, HEIGHT))
            xs = slice(col * 512, min((col + 1) * 512, WIDTH))
            cell = store.read_cell(t, row, col)
            assert cell.shape == (N_BAND, ys.stop - ys.start, xs.stop - xs.start)
            assert cell.dtype == np.uint16
            assert np.array_equal(cell, truth[t, :, ys, xs])
    assert store.read_cell(0, 1, 1).shape == (N_BAND, 188, 88)


def test_coarse_level_cell(synthetic):
    path, _, _ = synthetic
    store = chronozarr.open_store(path)
    assert store.levels[1].grid == (1, 1)
    assert store.read_cell(1, 0, 0, lod=1).shape == (N_BAND, 350, 300)
    with pytest.raises(IndexError, match="cell \\(0, 1\\) out of range"):
        store.read_cell(0, 0, 1, lod=1)


def test_stored_edge_chunks_are_padded_with_fill_value(tmp_path):
    truth = make_truth(N_TIME, N_BAND, HEIGHT, WIDTH)
    build_store(tmp_path / "s", truth, shard=False)
    raw = Zstd().decode((tmp_path / "s" / "0" / "data" / "c" / "0" / "0" / "1" / "1").read_bytes())
    chunk = np.frombuffer(raw, dtype="<u2").reshape(N_BAND, 512, 512)
    assert np.array_equal(chunk[:, :188, :88], truth[0, :, 512:, 512:])
    assert not chunk[:, 188:, :].any()
    assert not chunk[:, :, 88:].any()


def test_out_of_range_arguments_fail_with_context(synthetic):
    path, _, _ = synthetic
    store = chronozarr.open_store(path)
    with pytest.raises(IndexError, match="timestep 3 out of range: store has 3 timesteps"):
        store.read(3)
    with pytest.raises(IndexError, match="timestep -1"):
        store.read(-1)
    with pytest.raises(IndexError, match="lod 2 out of range"):
        store.read(0, lod=2)
    with pytest.raises(IndexError, match="cell \\(2, 0\\) out of range"):
        store.read_cell(0, 2, 0)


def test_to_xarray_subset_and_coordinates(synthetic):
    path, truth, _ = synthetic
    store = chronozarr.open_store(path)
    da = store.to_xarray(lod=0, times=[2, 1])
    assert da.dims == ("time", "band", "y", "x")
    assert np.array_equal(da.values, truth[[2, 1]])
    assert da.time.values.tolist() == store.times[[2, 1]].astype("datetime64[ns]").tolist()
    assert list(da.band.values) == ["B04", "B08"]
    assert da.attrs["crs"] == "EPSG:32631"
    y, x = schema.pixel_centers(store.levels[0].transform, HEIGHT, WIDTH)
    assert np.array_equal(da.y.values, y)
    assert np.array_equal(da.x.values, x)


def test_open_store_rejects_non_stores(tmp_path):
    with pytest.raises(schema.SchemaError, match="no Zarr v3 group"):
        chronozarr.open_store(tmp_path / "missing")
