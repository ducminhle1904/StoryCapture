#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "v4_slot_scheduler.hpp"
#include "wasapi_audio_capture.hpp"

namespace storycapture::wgc {

enum class TargetKind { display, window };
enum class CursorPolicy { include, exclude };

struct CaptureTarget {
  TargetKind kind{};
  std::wstring device_path;
  std::uint64_t hwnd{};
  std::uint32_t process_id{};
  std::wstring executable_path;
  std::wstring class_name;
};

struct CaptureOptions {
  std::wstring session_id;
  std::wstring ownership_token;
  CaptureTarget target;
  CursorPolicy cursor_policy{CursorPolicy::include};
  std::uint32_t requested_width{};
  std::uint32_t requested_height{};
  std::wstring output_path;
  bool native_mp4{};
  bool microphone_audio{};
  bool system_audio{};
  bool v4_mode{};
  std::wstring target_stable_id;
  std::wstring target_initial_title;
  std::wstring encoder_envelope_id;
  std::wstring encoder_envelope_source;
  std::uint32_t minimum_bitrate_bps{};
  std::uint32_t target_bitrate_bps{};
  std::uint32_t maximum_bitrate_bps{};
  double safety_headroom_ratio{};
};

struct NativeCaptureEvidence {
  std::wstring artifact_path;
  std::wstring encoder_id;
  std::uint32_t width{};
  std::uint32_t height{};
  std::uint64_t source_frames{};
  std::uint64_t output_frames{};
  std::uint64_t held_frames{};
  std::uint64_t encoder_dropped_frames{};
  std::uint64_t backpressure_events{};
  std::uint64_t unresolved_backpressure_events{};
  std::uint64_t pts_gaps{};
  std::uint64_t pts_duplicates{};
  std::uint64_t pts_non_monotonic{};
  bool initial_surface_received{};
  std::int64_t started_monotonic_us{};
  std::int64_t ended_monotonic_us{};
  std::int64_t finalized_duration_us{};
  std::uint32_t requested_bitrate_bps{};
  std::uint64_t artifact_bytes{};
  std::uint32_t average_bitrate_bps{};
  std::uint32_t peak_bitrate_bps{};
  std::uint32_t ring_high_water_mark{};
  std::vector<V4FrameLedgerEntry> frame_ledger;
  std::vector<V4PauseInterval> pause_intervals;
  std::vector<V4AudioEvidence> audio;
};

struct CommittedFrame {
  std::uint64_t delivery_sequence{};
  std::uint64_t source_frame_index{};
  std::int64_t native_pts_us{};
  std::int64_t duration_us{};
  std::uint32_t slot_index{};
  std::uint32_t width{};
  std::uint32_t height{};
  std::uint32_t stride{};
};

struct ProbeObservation {
  std::uint64_t source_presentations{};
  std::int64_t first_pts_us{-1};
  std::int64_t last_pts_us{-1};
  std::uint64_t sequence_gaps{};
  std::uint64_t stale_reuses{};
  std::uint32_t physical_width{};
  std::uint32_t physical_height{};
  std::wstring gpu_identity;
  std::wstring adapter_luid;
  std::wstring hardware_fingerprint;
  bool permissions_granted{};
  std::vector<std::wstring> failure_codes;
};

}  // namespace storycapture::wgc
