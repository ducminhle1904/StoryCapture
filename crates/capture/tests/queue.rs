//! Integration tests for the byte-bounded queue.

use capture::{ByteBoundedQueue, Frame, FrameData, PixelFormat, Pts};
use std::sync::Arc;

fn owned_frame(seq: u64, size_bytes: usize) -> Frame {
    Frame {
        pts: Pts::synthetic(seq as i128 * 16_666_666),
        width_px: 1,
        height_px: 1,
        format: PixelFormat::Bgra,
        data: FrameData::Owned(vec![0u8; size_bytes], size_bytes),
        sequence: seq,
    }
}

#[test]
fn drops_on_cap() {
    let q = ByteBoundedQueue::new(1000);
    q.try_push(owned_frame(0, 400)).unwrap();
    q.try_push(owned_frame(1, 400)).unwrap();
    // Total = 800; pushing 400 more would exceed 1000 → drop.
    let err = q.try_push(owned_frame(2, 400)).unwrap_err();
    assert_eq!(err.cap_bytes, 1000);
    assert_eq!(err.size_bytes, 400);
    assert_eq!(q.stats().dropped_frames, 1);
    assert_eq!(q.stats().total_pushed, 2);
    assert_eq!(q.current_bytes(), 800);
}

#[test]
fn fifo_order() {
    let q = ByteBoundedQueue::new(10_000);
    q.try_push(owned_frame(0, 100)).unwrap();
    q.try_push(owned_frame(1, 100)).unwrap();
    q.try_push(owned_frame(2, 100)).unwrap();
    assert_eq!(q.try_pop().unwrap().sequence, 0);
    assert_eq!(q.try_pop().unwrap().sequence, 1);
    assert_eq!(q.try_pop().unwrap().sequence, 2);
    assert!(q.try_pop().is_none());
}

#[test]
fn bytes_accounting() {
    let q = ByteBoundedQueue::new(1000);
    for seq in 0..3 {
        q.try_push(owned_frame(seq, 300)).unwrap();
    }
    assert_eq!(q.current_bytes(), 900);
    // 4th drops; current_bytes stays at 900.
    let _ = q.try_push(owned_frame(3, 300)).unwrap_err();
    assert_eq!(q.current_bytes(), 900);
    // Pop one frame; current_bytes should now equal 600 and the next
    // 300-byte push fits (900 - 300 + 300 = 900).
    let _ = q.try_pop().unwrap();
    assert_eq!(q.current_bytes(), 600);
    q.try_push(owned_frame(4, 300)).unwrap();
    assert_eq!(q.current_bytes(), 900);
}

#[tokio::test]
async fn concurrent_push_recv() {
    let q = ByteBoundedQueue::new(10_000);
    let producer_q: Arc<ByteBoundedQueue> = q.clone();
    let consumer_q: Arc<ByteBoundedQueue> = q.clone();
    let producer = tokio::spawn(async move {
        for seq in 0..1000u64 {
            // Some pushes will be dropped under contention; that's OK for
            // this test — we just want no deadlock and accurate counters.
            let _ = producer_q.try_push(owned_frame(seq, 50));
            tokio::task::yield_now().await;
        }
        producer_q.close();
    });
    let consumer = tokio::spawn(async move {
        let mut count = 0u64;
        while let Some(_frame) = consumer_q.recv().await {
            count += 1;
        }
        count
    });
    producer.await.unwrap();
    let consumed = consumer.await.unwrap();
    let stats = q.stats();
    assert_eq!(stats.total_popped, consumed);
    assert_eq!(stats.total_pushed + stats.dropped_frames, 1000);
}

#[test]
fn max_bytes_seen_tracked() {
    let q = ByteBoundedQueue::new(10_000);
    q.try_push(owned_frame(0, 1000)).unwrap();
    q.try_push(owned_frame(1, 2000)).unwrap();
    assert_eq!(q.stats().max_bytes_seen, 3000);
    let _ = q.try_pop();
    // max_bytes_seen is a high-water mark, doesn't decrease on pop.
    assert_eq!(q.stats().max_bytes_seen, 3000);
}
