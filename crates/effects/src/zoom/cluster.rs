//! Spatial + temporal clustering of waypoints (Research §4 Code Example 4).
//!
//! A [`ZoomCluster`] describes a region the camera should focus on for a
//! contiguous time range. Clusters are derived from adjacent waypoints whose
//! spatial distance is `<200 px` AND whose time gap is `<800 ms`
//! — matching the Research §4 heuristics.

use crate::ast::types::Vec2;
use crate::math::min_jerk::{Waypoint, WaypointKind};
use crate::math::vec2::Vec2Ops;

use super::presets::ZoomPreset;

/// Distance threshold (px) for considering two waypoints part of the same cluster.
pub(crate) const CLUSTER_SPATIAL_PX: f32 = 200.0;
/// Time-gap threshold (ms) for considering two waypoints part of the same cluster.
pub(crate) const CLUSTER_TEMPORAL_MS: u64 = 800;
/// Padding factor around the bbox when computing the zoom scale.
pub(crate) const BBOX_PADDING: f32 = 1.2;

/// One focus region + time range the camera should dwell on.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ZoomCluster {
    pub t_start_ms: u64,
    pub t_end_ms: u64,
    pub center: Vec2,
    pub scale: f32,
    pub weight: f32,
}

impl ZoomCluster {
    #[inline]
    pub fn duration_ms(&self) -> u64 {
        self.t_end_ms.saturating_sub(self.t_start_ms)
    }
}

/// Importance weight per waypoint kind (Research §4).
///
/// Click is the strongest signal (1.0); scroll is the weakest (0.2). The
/// `enforce_change_budget` pass uses the sum-of-weights per cluster to pick
/// which clusters to drop when the max_changes_per_min budget is exceeded.
#[inline]
pub(crate) fn waypoint_weight(kind: WaypointKind) -> f32 {
    match kind {
        WaypointKind::Click => 1.0,
        WaypointKind::Type => 0.7,
        WaypointKind::Drag => 0.6,
        WaypointKind::Hover => 0.4,
        WaypointKind::Scroll => 0.2,
    }
}

/// Group consecutive waypoints whose spatial distance < 200px AND time gap <
/// 800ms into [`ZoomCluster`]s.
///
/// Assumes `waypoints` is ordered by `t_ms` ascending.
///
/// For each group:
/// - `center` = centroid (mean of positions)
/// - `scale`  = `min(preset.max_zoom, viewport_w / (bbox_w * padding))`
/// - `weight` = sum of per-waypoint weights
/// - `t_start_ms` / `t_end_ms` = first / last waypoint times
pub fn cluster_waypoints(
    waypoints: &[Waypoint],
    preset: &ZoomPreset,
    viewport_w: u32,
    viewport_h: u32,
) -> Vec<ZoomCluster> {
    if waypoints.is_empty() {
        return Vec::new();
    }

    let mut groups: Vec<Vec<Waypoint>> = Vec::new();
    for wp in waypoints {
        let push_new = match groups.last() {
            None => true,
            Some(g) => {
                // Compare against most recent waypoint in last group.
                let last = g.last().copied().expect("non-empty group");
                let dist = wp.pos.sub(last.pos).length();
                let dt = wp.t_ms.saturating_sub(last.t_ms);
                dist >= CLUSTER_SPATIAL_PX || dt >= CLUSTER_TEMPORAL_MS
            }
        };
        if push_new {
            groups.push(vec![*wp]);
        } else {
            groups
                .last_mut()
                .expect("just-pushed group exists")
                .push(*wp);
        }
    }

    groups
        .into_iter()
        .map(|g| make_cluster(&g, preset, viewport_w, viewport_h))
        .collect()
}

fn make_cluster(
    group: &[Waypoint],
    preset: &ZoomPreset,
    viewport_w: u32,
    viewport_h: u32,
) -> ZoomCluster {
    debug_assert!(!group.is_empty());

    // Centroid
    let (mut sx, mut sy) = (0.0f32, 0.0f32);
    let (mut min_x, mut min_y) = (f32::INFINITY, f32::INFINITY);
    let (mut max_x, mut max_y) = (f32::NEG_INFINITY, f32::NEG_INFINITY);
    let mut weight = 0.0f32;
    for wp in group {
        sx += wp.pos.x;
        sy += wp.pos.y;
        min_x = min_x.min(wp.pos.x);
        min_y = min_y.min(wp.pos.y);
        max_x = max_x.max(wp.pos.x);
        max_y = max_y.max(wp.pos.y);
        weight += waypoint_weight(wp.kind);
    }
    let n = group.len() as f32;
    let center = Vec2::new(sx / n, sy / n);

    // Bounding-box → scale. Use max of axial scales; pad by BBOX_PADDING.
    let bbox_w = (max_x - min_x).max(1.0);
    let bbox_h = (max_y - min_y).max(1.0);
    // Desired scale is the ratio that fits the bbox into the viewport with padding.
    // Smaller bbox → larger scale. Clamp to [1.0, preset.max_zoom].
    let scale_w = viewport_w as f32 / (bbox_w * BBOX_PADDING);
    let scale_h = viewport_h as f32 / (bbox_h * BBOX_PADDING);
    let scale_raw = scale_w.min(scale_h);
    let scale = scale_raw.clamp(1.0, preset.max_zoom);

    // t_start / t_end: first → last waypoint timestamps.
    let t_start_ms = group.first().unwrap().t_ms;
    let mut t_end_ms = group.last().unwrap().t_ms;
    // A single-waypoint cluster has zero duration; extend by dwell_ms so
    // there is at least a visible hold. This is still subject to later
    // min_shot_ms merging.
    if t_end_ms == t_start_ms {
        t_end_ms = t_start_ms + preset.dwell_ms;
    }

    ZoomCluster {
        t_start_ms,
        t_end_ms,
        center,
        scale,
        weight,
    }
}

/// Merge clusters shorter than `min_shot_ms` with their predecessor. The
/// merged cluster takes the union time range, weight-averaged center, and
/// max scale.
///
/// If the first cluster is short, it is merged with the next one instead.
pub fn merge_short_clusters(clusters: &mut Vec<ZoomCluster>, min_shot_ms: u64) {
    if clusters.len() < 2 {
        return;
    }
    let mut i = 0;
    while i < clusters.len() {
        if clusters[i].duration_ms() < min_shot_ms {
            if i > 0 {
                // Merge into predecessor.
                let cur = clusters.remove(i);
                let prev = &mut clusters[i - 1];
                *prev = merge_two(*prev, cur);
                // Don't increment i — re-evaluate merged cluster vs next.
            } else if clusters.len() > 1 {
                // Merge into successor.
                let cur = clusters.remove(0);
                let next = &mut clusters[0];
                *next = merge_two(cur, *next);
                // i stays 0, re-evaluate.
            } else {
                // Only one cluster total — can't merge, accept it.
                break;
            }
        } else {
            i += 1;
        }
    }
}

fn merge_two(a: ZoomCluster, b: ZoomCluster) -> ZoomCluster {
    let total_w = (a.weight + b.weight).max(f32::EPSILON);
    let cx = (a.center.x * a.weight + b.center.x * b.weight) / total_w;
    let cy = (a.center.y * a.weight + b.center.y * b.weight) / total_w;
    ZoomCluster {
        t_start_ms: a.t_start_ms.min(b.t_start_ms),
        t_end_ms: a.t_end_ms.max(b.t_end_ms),
        center: Vec2::new(cx, cy),
        scale: a.scale.max(b.scale),
        weight: a.weight + b.weight,
    }
}

/// Enforce `max_changes_per_min` by dropping lowest-weight clusters until the
/// effective rate falls within budget. The total timeline length is taken
/// from the last cluster's `t_end_ms`.
///
/// This is the Research §4 motion-sickness guard (T-02-14 mitigation):
/// prevents a 30-min recording from yielding a 900-keyframe zoompan
/// expression.
pub fn enforce_change_budget(clusters: &mut Vec<ZoomCluster>, max_changes_per_min: u32) {
    if clusters.len() <= 1 {
        return;
    }
    let timeline_ms = clusters.last().map(|c| c.t_end_ms).unwrap_or(0);
    if timeline_ms == 0 {
        return;
    }
    let timeline_min = (timeline_ms as f32 / 60_000.0).max(1.0 / 60.0);
    let max_allowed = ((max_changes_per_min as f32) * timeline_min).ceil() as usize;
    while clusters.len() > max_allowed {
        // Find lowest-weight cluster index.
        let (drop_idx, _) = clusters
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| a.weight.partial_cmp(&b.weight).unwrap_or(std::cmp::Ordering::Equal))
            .expect("non-empty");
        clusters.remove(drop_idx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::min_jerk::Waypoint;

    fn wp(t_ms: u64, x: f32, y: f32, kind: WaypointKind) -> Waypoint {
        Waypoint { t_ms, pos: Vec2::new(x, y), kind }
    }

    #[test]
    fn clustering_spatial() {
        // Three clicks within 100px and 500ms → one cluster.
        let wps = [
            wp(0, 100.0, 100.0, WaypointKind::Click),
            wp(200, 120.0, 105.0, WaypointKind::Click),
            wp(500, 140.0, 110.0, WaypointKind::Click),
        ];
        let clusters = cluster_waypoints(&wps, &super::super::presets::DYNAMIC, 1920, 1080);
        assert_eq!(clusters.len(), 1);
        assert!((clusters[0].center.x - 120.0).abs() < 1e-3);
    }

    #[test]
    fn clustering_temporal_split() {
        // Two clicks at the same point, 1500ms apart → two clusters
        // (exceeds 800ms temporal threshold).
        let wps = [
            wp(0, 100.0, 100.0, WaypointKind::Click),
            wp(1500, 100.0, 100.0, WaypointKind::Click),
        ];
        let clusters = cluster_waypoints(&wps, &super::super::presets::DYNAMIC, 1920, 1080);
        assert_eq!(clusters.len(), 2);
    }

    #[test]
    fn clustering_empty_input() {
        let clusters = cluster_waypoints(&[], &super::super::presets::DYNAMIC, 1920, 1080);
        assert!(clusters.is_empty());
    }

    #[test]
    fn clustering_spatial_split() {
        // Two clicks 300px apart within 500ms → two clusters.
        let wps = [
            wp(0, 100.0, 100.0, WaypointKind::Click),
            wp(300, 500.0, 100.0, WaypointKind::Click),
        ];
        let clusters = cluster_waypoints(&wps, &super::super::presets::DYNAMIC, 1920, 1080);
        assert_eq!(clusters.len(), 2);
    }

    #[test]
    fn merge_short_clusters_absorbs_into_predecessor() {
        let mut clusters = vec![
            ZoomCluster {
                t_start_ms: 0,
                t_end_ms: 3000,
                center: Vec2::new(100.0, 100.0),
                scale: 1.5,
                weight: 2.0,
            },
            ZoomCluster {
                t_start_ms: 3200,
                t_end_ms: 3600, // 400ms duration — below 1200 default
                center: Vec2::new(500.0, 500.0),
                scale: 2.0,
                weight: 1.0,
            },
        ];
        merge_short_clusters(&mut clusters, 1200);
        assert_eq!(clusters.len(), 1);
        assert_eq!(clusters[0].t_end_ms, 3600);
        // weighted center ≈ (100*2 + 500*1)/3 ≈ 233.33
        assert!((clusters[0].center.x - 700.0 / 3.0).abs() < 1e-3);
        // max scale
        assert!((clusters[0].scale - 2.0).abs() < 1e-3);
    }

    #[test]
    fn enforce_change_budget_drops_lowest_weight() {
        let mut clusters: Vec<ZoomCluster> = (0..30)
            .map(|i| ZoomCluster {
                t_start_ms: i as u64 * 2000,
                t_end_ms: i as u64 * 2000 + 1500,
                center: Vec2::new(i as f32 * 10.0, 0.0),
                scale: 2.0,
                weight: if i % 2 == 0 { 0.2 } else { 1.0 }, // evens = low weight
            })
            .collect();
        // Timeline ≈ 60s → 1 min → allowed = 10 for DYNAMIC.
        enforce_change_budget(&mut clusters, 10);
        assert!(clusters.len() <= 10);
        // All survivors should be high-weight (odd indices, weight=1.0).
        for c in &clusters {
            assert!((c.weight - 1.0).abs() < 1e-3);
        }
    }
}
