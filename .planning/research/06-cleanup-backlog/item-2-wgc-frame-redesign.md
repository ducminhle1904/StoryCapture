# Item #2 — WGC Per-Frame Allocation: Implementation Research

**Domain:** `crates/capture` + `crates/encoder` interop
**Confidence:** HIGH (full source read)
**Date:** 2026-04-17

## Problem

At 1080p30 BGRA (1920·1080·4 = ~8.3 MB/frame), the WGC path performs **two**
full-frame heap allocations per frame, not one:

1. `crates/capture/src/windows/frame_from_wgc.rs:169` — `vec![0u8; stride*height]`
   passed to `FrameBuffer::as_nopadding_buffer`. When the underlying D3D11
   row pitch already equals `width*4`, `windows-capture` returns a borrow of
   *its own* staging buffer (line 172: `same_buffer` branch) and our
   pre-allocated `bgra` is discarded via `truncate`. When row pitch ≠
   `width*4`, `copied.to_vec()` (line 178) allocates a second buffer.
2. `crates/encoder/src/pipeline.rs:80` — `Ok((bytes.clone(), *stride))` inside
   `bgra_bytes_of_frame` clones the full BGRA buffer **again** on every
   frame, purely because the signature returns `(Vec<u8>, usize)`.

Combined: 1–2 × 8 MB/frame × 30 fps = **240–480 MB/s allocation churn** at
1080p30; ~1 GB/s at 4K30. Allocator fragmentation + TLB pressure dominate
the frame pump once the rest of the pipeline stabilizes.

The crop branch (`wgc_backend.rs:161–187`) adds a third allocation but only
for `DisplayRegion` targets and is out of scope for this item.

## Consumers of `FrameData::Owned` (complete list)

| Site | File:Line | Needs Owned? |
|------|-----------|--------------|
| Encoder frame pump | `encoder/src/pipeline.rs:80, 151, 159` | **No** — `stdin.write_all(&bytes)` borrows |
| E2E test assertion | `capture/tests/windows_real_capture_e2e.rs:64` | Borrow (`as_slice`) |
| `byte_size` accounting | `capture/src/frame.rs:132` | Borrow (`v.len()`) |
| Crop pass-through | `capture/src/windows/wgc_backend.rs:152` | Borrow (`as_slice`) |
| Debug impl | `capture/src/frame.rs:99` | Borrow |

**Conclusion:** No consumer needs ownership. The `Vec<u8>` is a cache-line
of history, not a requirement.

## Options

### Option A — Borrow in the encoder + buffer pool in the handler (RECOMMENDED)

Two-step change, each independently mergeable:

**A1. Drop the `bytes.clone()`.** Change `bgra_bytes_of_frame` signature from
`Result<(Vec<u8>, usize)>` to `Result<(&[u8], usize)>` (or split: a
borrow-returning variant for `Owned`, and keep `to_owned_bgra` on the
macOS handle). Encoder `stdin.write_all(&bytes).await` (`pipeline.rs:159`)
already borrows — trivial at the call site. **Immediate win: −8 MB/frame,
zero risk.**

**A2. Buffer pool in `WgcHandler`.** Add
`scratch_pool: Vec<Vec<u8>>` (Vec-of-Vec; no Arc/Mutex — the handler
thread is single-producer by contract: "NEVER block or await inside
on_frame_arrived", `wgc_backend.rs:134`). Introduce a new enum variant:

```rust
pub enum FrameData {
    ...
    Owned(Vec<u8>, usize),              // xcap fallback; unchanged
    Pooled(PooledBuf, usize),           // NEW — WGC path
}

pub struct PooledBuf {
    bytes: ManuallyDrop<Vec<u8>>,
    pool: Weak<Mutex<Vec<Vec<u8>>>>,    // Weak so late drops after stop are safe
}
impl Deref for PooledBuf { type Target = [u8]; ... }
impl Drop for PooledBuf {
    fn drop(&mut self) {
        let buf = unsafe { ManuallyDrop::take(&mut self.bytes) };
        if let Some(pool) = self.pool.upgrade() {
            let mut g = pool.lock();
            if g.len() < MAX_POOLED { g.push(buf); }
        }
    }
}
```

Pool lives in `WgcBackend` (not `WgcHandler`) so it survives capture-thread
teardown; hand a `Weak` to each frame. Pool cap = 4 buffers
(queue depth is 64 frames, but steady-state drains to ≤2–3 in flight; extra
buffers are wasted RSS).

**Pros:** Transparent to encoder after A1; no async changes; matches
windows-capture 2.0 threading model (the handler thread owns the pool).
**Cons:** New enum variant → every `match` on `FrameData` must add an arm
(6 sites — all listed above; mechanical).

### Option B — `FrameData::Shared(Arc<[u8]>, stride)`

Rejected. `Arc<[u8]>` is immutable; producer can't refill the same
allocation until the consumer drops. At queue depth ≥2 this forces a new
allocation per frame — identical to status quo.

### Option C — Producer-owned scratch, copy at emission

Rejected. This is what we have now (line 169).

### Option D — Custom ring buffer channel (e.g. `rtrb`)

Rejected for this item. Requires replacing `mpsc::Sender<Frame>` across
the `CaptureBackend` trait (`backend.rs:80`), breaking SCK and xcap. Reopen
if Option A doesn't hit budget under 4K60.

## Recommendation

**Option A (A1 first, A2 second).** A1 is a one-file change that eliminates
50% of the churn with zero architectural risk. A2 eliminates the remaining
50% with a localized enum extension.

## Migration Steps

1. **A1 — encoder borrow** (single PR, ~1 hour):
   - `encoder/src/pipeline.rs:78–92` — change return to `Result<(&[u8], usize)>`; lifetime tied to `&Frame`.
   - `encoder/src/pipeline.rs:151` — destructure as `(bytes, _stride)`; remove `.clone()` from macOS `to_owned_bgra` path by keeping its branch returning an owned `Vec<u8>` via a dedicated helper `bgra_bytes_owned_macos` (only used there).
   - Update `pipeline.rs:399` test and `encoder/tests/fixtures/synthetic.rs:48`.
2. **A2 — pool + `Pooled` variant** (~1 day):
   - `capture/src/frame.rs` — add `FrameData::Pooled(PooledBuf, usize)`; add `byte_size` + `Debug` arms.
   - `capture/src/windows/pool.rs` (new) — `FramePool` with `Arc<Mutex<Vec<Vec<u8>>>>`, `acquire(min_cap) -> Vec<u8>`, `MAX_POOLED = 4`.
   - `capture/src/windows/wgc_backend.rs` — `WgcBackend` owns `Arc<Mutex<Vec<Vec<u8>>>>`; pass `Arc::downgrade(&pool)` into `WgcFlags`; handler stores `Weak`.
   - `capture/src/windows/frame_from_wgc.rs:156` — `to_frame` signature grows `pool: &Arc<Mutex<...>>`; replace `vec![0u8; ...]` with `pool.lock().pop().unwrap_or_else(|| Vec::with_capacity(n))`; return `FrameData::Pooled`.
   - Update crop branch (`wgc_backend.rs:149`) to match on `Pooled` too; the crop output allocates fresh (separate size, not pool-eligible).
   - Encoder: add `FrameData::Pooled(buf, _) => Ok((&buf[..], *stride))` arm in `bgra_bytes_of_frame`.

## Test Plan

- **Unit:** `capture::windows::pool` — pool reuses buffers; Weak drops are safe post-stop.
- **Existing:** `capture/tests/windows_real_capture_e2e.rs:64` — add `Pooled` arm returning `as_slice`.
- **Bench (new):** `crates/capture/benches/wgc_alloc.rs` using `criterion` + `dhat` heap profiler — capture 300 frames @ 1080p30, assert `dhat::HeapStats::curr_blocks` stable (≤ pool_cap + queue_depth blocks of 8 MB class) across the run. Baseline today: monotonic growth dominated by the encoder `clone`.
- **Soak:** `capture/tests/soak.rs` already runs long — add RSS assertion (peak < 1.5 × steady-state).

## Risks

- **Pool starvation under burst:** If encoder stalls, pool empties → falls back to `Vec::with_capacity`, identical to today. Safe.
- **`Weak` upgrade failure after stop:** Normal — frame dropped post-stop discards the buffer. No leak, no UAF (buffer is still owned by `ManuallyDrop`).
- **`match` exhaustiveness:** Rust compiler enforces — can't miss a site.
- **macOS / xcap paths:** Untouched. `FrameData::Owned` remains for xcap; `NativeMacOS` remains for SCK.
- **A2 before A1:** Pointless — encoder's `clone()` would copy the pooled buffer anyway, negating the win. Land A1 first.
