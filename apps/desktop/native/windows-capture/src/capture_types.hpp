#pragma once

#include <cstdint>
#include <string>
#include <vector>

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
  bool microphone_audio{};
  bool system_audio{};
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
