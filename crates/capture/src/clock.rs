//! Single clock source per platform.
//!
//! - macOS: `mach_absolute_time` scaled by `mach_timebase_info`.
//! - Windows: `QueryPerformanceCounter` scaled by `QueryPerformanceFrequency`.
//!
//! The capture backends preserve the capture-API PTS and don't actually
//! call this for every frame — these are exposed for higher-level code
//! (recording HUD, live cursor overlays) that needs a coherent clock
//! reading on the same base as the captured frames' PTS.

use crate::frame::{ClockSource, Pts};

pub trait Clock: Send + Sync {
    fn now(&self) -> Pts;
    fn source(&self) -> ClockSource;
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::sync::OnceLock;

    extern "C" {
        fn mach_absolute_time() -> u64;
        fn mach_timebase_info(info: *mut MachTimebaseInfo) -> i32;
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct MachTimebaseInfo {
        numer: u32,
        denom: u32,
    }

    static TIMEBASE: OnceLock<MachTimebaseInfo> = OnceLock::new();

    fn timebase() -> MachTimebaseInfo {
        *TIMEBASE.get_or_init(|| {
            let mut info = MachTimebaseInfo::default();
            unsafe { mach_timebase_info(&mut info) };
            if info.denom == 0 {
                MachTimebaseInfo { numer: 1, denom: 1 }
            } else {
                info
            }
        })
    }

    pub struct HostTimeClock;

    impl Clock for HostTimeClock {
        fn now(&self) -> Pts {
            let raw = unsafe { mach_absolute_time() };
            let tb = timebase();
            let ns = (raw as u128 * tb.numer as u128 / tb.denom as u128) as i128;
            Pts {
                ns,
                source: ClockSource::HostTime,
            }
        }
        fn source(&self) -> ClockSource {
            ClockSource::HostTime
        }
    }

    pub fn default_clock() -> Box<dyn Clock> {
        Box::new(HostTimeClock)
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::sync::OnceLock;
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

    static FREQ: OnceLock<i64> = OnceLock::new();

    fn freq() -> i64 {
        *FREQ.get_or_init(|| {
            let mut f = 0i64;
            unsafe {
                let _ = QueryPerformanceFrequency(&mut f);
            }
            if f == 0 {
                1
            } else {
                f
            }
        })
    }

    pub struct QpcClock;

    impl Clock for QpcClock {
        fn now(&self) -> Pts {
            let mut counter = 0i64;
            unsafe {
                let _ = QueryPerformanceCounter(&mut counter);
            }
            // counter / freq * 1e9
            let ns = (counter as i128) * 1_000_000_000i128 / freq() as i128;
            Pts {
                ns,
                source: ClockSource::Qpc,
            }
        }
        fn source(&self) -> ClockSource {
            ClockSource::Qpc
        }
    }

    pub fn default_clock() -> Box<dyn Clock> {
        Box::new(QpcClock)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::*;
    use std::sync::OnceLock;
    use std::time::Instant;

    static EPOCH: OnceLock<Instant> = OnceLock::new();

    pub struct StdClock;

    impl Clock for StdClock {
        fn now(&self) -> Pts {
            let epoch = *EPOCH.get_or_init(Instant::now);
            let ns = epoch.elapsed().as_nanos() as i128;
            Pts {
                ns,
                source: ClockSource::Synthetic,
            }
        }
        fn source(&self) -> ClockSource {
            ClockSource::Synthetic
        }
    }

    pub fn default_clock() -> Box<dyn Clock> {
        Box::new(StdClock)
    }
}

pub use platform::default_clock;
