//! `XfadeTimeline`: given a list of clip durations + a list of transitions,
//! compute the FFmpeg `xfade offset=` value for each transition (Research §5,
//! Pitfall #6 mitigation).
//!
//! Formula (Research §5 Code Example 3):
//!
//! ```text
//! offset_N = sum(clip_durations[0..=boundary_N]) - sum(transition_durations[0..N]) - transition_durations[N]
//! ```
//!
//! i.e. the xfade starts `transition_duration` milliseconds before the end of
//! the currently-active clip, where "the end of the active clip" is the sum of
//! clips through the boundary minus the sum of transition durations already
//! consumed.

use crate::ast::video::XfadeKind;

/// A scene timeline: clips joined at `boundary` indices by transitions.
#[derive(Debug, Clone, PartialEq)]
pub struct XfadeTimeline {
    /// Per-clip durations in milliseconds, in timeline order.
    pub clip_durations_ms: Vec<u64>,
    /// Transitions: `(boundary, kind, duration_ms)`. `boundary == i` means
    /// "transition from clip i to clip i+1". Boundaries must be strictly
    /// increasing.
    pub transitions: Vec<(usize, XfadeKind, u32)>,
}

/// Compute the per-transition `xfade offset=` values in milliseconds.
///
/// Returns one `offset_ms` per transition, in the same order as
/// `tl.transitions`. When `transitions` is empty the result is empty
/// (default = none per D-25).
pub fn compute_offsets(tl: &XfadeTimeline) -> Vec<u32> {
    let mut offsets = Vec::with_capacity(tl.transitions.len());
    for (i, (boundary, _kind, dur)) in tl.transitions.iter().enumerate() {
        let b = *boundary;
        debug_assert!(b < tl.clip_durations_ms.len(), "boundary out of range");
        // Sum of clip durations through the active clip at this boundary.
        let sum_clips: u64 = tl.clip_durations_ms[0..=b].iter().sum();
        // Sum of transition durations consumed so far (strictly before i).
        let sum_trans: u64 = tl.transitions[0..i].iter().map(|(_, _, d)| *d as u64).sum();
        // Research §5: offset = (sum_clips - sum_trans) - transition_duration.
        let raw = sum_clips
            .saturating_sub(sum_trans)
            .saturating_sub(*dur as u64);
        offsets.push(raw as u32);
    }
    offsets
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets_single_transition() {
        let tl = XfadeTimeline {
            clip_durations_ms: vec![10_000, 10_000],
            transitions: vec![(0, XfadeKind::Fade, 1000)],
        };
        assert_eq!(compute_offsets(&tl), vec![9_000]);
    }

    #[test]
    fn offsets_chained_three() {
        let tl = XfadeTimeline {
            clip_durations_ms: vec![10_000, 10_000, 10_000],
            transitions: vec![(0, XfadeKind::Fade, 1000), (1, XfadeKind::Dissolve, 1000)],
        };
        // Per Research §5 Code Example 3:
        //   offset_0 = 10000 - 0 - 1000 = 9000
        //   offset_1 = (10000+10000) - 1000 - 1000 = 18000
        assert_eq!(compute_offsets(&tl), vec![9_000, 18_000]);
    }

    #[test]
    fn offsets_varying_durations() {
        let tl = XfadeTimeline {
            clip_durations_ms: vec![5000, 8000, 12000],
            transitions: vec![(0, XfadeKind::Fade, 500), (1, XfadeKind::WipeLeft, 300)],
        };
        // offset_0 = 5000 - 0 - 500 = 4500
        // offset_1 = (5000+8000) - 500 - 300 = 12200
        assert_eq!(compute_offsets(&tl), vec![4_500, 12_200]);
    }

    #[test]
    fn default_is_none() {
        let tl = XfadeTimeline {
            clip_durations_ms: vec![5000, 5000, 5000],
            transitions: vec![],
        };
        assert_eq!(compute_offsets(&tl), Vec::<u32>::new());
    }
}
