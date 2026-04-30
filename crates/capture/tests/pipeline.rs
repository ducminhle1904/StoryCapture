//! Pipeline integration tests using a mock backend that emits synthetic
//! frames. Verifies PTS preservation and backpressure drop accounting
//! without touching any platform API.

use async_trait::async_trait;
use capture::{
    BackendKind, ByteBoundedQueue, CaptureBackend, CaptureConfig, CaptureError, CapturePipeline,
    CaptureStats, DisplayId, DisplayInfo, Frame, FrameData, PixelFormat, Pts,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

struct MockBackend {
    n_frames: u64,
    frame_size: usize,
    interval_ns: i128,
    delay_ms: u64,
    started: Arc<AtomicBool>,
}

#[async_trait]
impl CaptureBackend for MockBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Native
    }

    async fn start(
        &mut self,
        _cfg: CaptureConfig,
        out: mpsc::Sender<Frame>,
    ) -> Result<(), CaptureError> {
        self.started.store(true, Ordering::Release);
        let n = self.n_frames;
        let size = self.frame_size;
        let step = self.interval_ns;
        let delay = self.delay_ms;
        tokio::spawn(async move {
            for seq in 0..n {
                let frame = Frame {
                    pts: Pts::synthetic(seq as i128 * step),
                    width_px: 16,
                    height_px: 9,
                    format: PixelFormat::Bgra,
                    data: FrameData::Owned(vec![0u8; size], size),
                    sequence: seq,
                };
                if out.send(frame).await.is_err() {
                    break;
                }
                if delay > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }
            }
        });
        Ok(())
    }

    async fn stop(&mut self) -> Result<CaptureStats, CaptureError> {
        Ok(CaptureStats::default())
    }

    fn list_displays(&self) -> Result<Vec<DisplayInfo>, CaptureError> {
        Ok(vec![DisplayInfo {
            id: DisplayId(0),
            name: "mock".into(),
            x: 0,
            y: 0,
            width_px: 16,
            height_px: 9,
            scale_factor: 1.0,
            is_primary: true,
        }])
    }
}

#[tokio::test]
async fn mock_backend_forwards_frames_with_pts_preserved() {
    let started = Arc::new(AtomicBool::new(false));
    let backend = MockBackend {
        n_frames: 60,
        frame_size: 32,
        interval_ns: 16_666_666,
        delay_ms: 0,
        started: started.clone(),
    };
    let queue = ByteBoundedQueue::new(64 * 1024);
    let mut pipeline = CapturePipeline::new(Box::new(backend), queue);
    let (tx, mut rx) = mpsc::channel::<Frame>(128);
    pipeline
        .start(CaptureConfig::new(DisplayId(0)), tx, None)
        .await
        .unwrap();

    let mut received = Vec::new();
    while received.len() < 60 {
        match tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await {
            Ok(Some(f)) => received.push(f),
            _ => break,
        }
    }
    assert!(started.load(Ordering::Acquire));
    assert_eq!(received.len(), 60, "all frames forwarded");
    for (i, f) in received.iter().enumerate() {
        assert_eq!(f.sequence, i as u64);
        assert_eq!(f.pts.ns, i as i128 * 16_666_666, "PTS preserved verbatim");
    }
}

#[tokio::test]
async fn mock_backend_drops_under_backpressure() {
    let started = Arc::new(AtomicBool::new(false));
    let backend = MockBackend {
        n_frames: 200,
        frame_size: 1000,
        interval_ns: 1_000_000,
        delay_ms: 0,
        started: started.clone(),
    };
    // Tiny queue + slow consumer → many drops.
    let queue = ByteBoundedQueue::new(2000);
    let queue_ref = queue.clone();
    let mut pipeline = CapturePipeline::new(Box::new(backend), queue);
    let (tx, mut rx) = mpsc::channel::<Frame>(2);
    pipeline
        .start(CaptureConfig::new(DisplayId(0)), tx, None)
        .await
        .unwrap();

    let consumer = tokio::spawn(async move {
        let mut count = 0u64;
        while count < 50 {
            match tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await {
                Ok(Some(_)) => {
                    count += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                _ => break,
            }
        }
        count
    });
    let _consumed = consumer.await.unwrap();
    let stats = queue_ref.stats();
    assert!(
        stats.dropped_frames > 0,
        "expected drops under backpressure, got {:?}",
        stats
    );
}
