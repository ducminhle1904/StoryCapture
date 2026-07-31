#pragma once

#include <cstdint>
#include <optional>
#include <vector>

namespace storycapture::wgc {

inline constexpr std::int64_t k_v4_timescale_us = 1'000'000;
inline constexpr std::int64_t k_v4_frame_rate = 60;

struct V4PauseInterval {
  std::int64_t started_monotonic_us{};
  std::int64_t ended_monotonic_us{};
};

struct V4FrameLedgerEntry {
  std::uint64_t slot{};
  std::int64_t pts_us{};
  std::uint64_t source_sequence{};
  std::int64_t source_timestamp_us{};
  std::optional<std::uint64_t> held_from_slot;
  std::int64_t submitted_at_us{};
  std::int64_t acknowledged_at_us{};
};

[[nodiscard]] constexpr std::int64_t v4_pts_us(std::uint64_t slot) noexcept {
  return static_cast<std::int64_t>((slot * k_v4_timescale_us + k_v4_frame_rate / 2) /
                                   k_v4_frame_rate);
}

[[nodiscard]] constexpr std::uint64_t v4_expected_frames(std::int64_t active_duration_us) noexcept {
  if (active_duration_us <= 0) return 0;
  return static_cast<std::uint64_t>((active_duration_us * k_v4_frame_rate +
                                     k_v4_timescale_us / 2) /
                                    k_v4_timescale_us);
}

class V4SlotScheduler final {
 public:
  void start(std::int64_t monotonic_us);
  void pause(std::int64_t monotonic_us);
  void resume(std::int64_t monotonic_us);
  [[nodiscard]] std::int64_t active_time_us(std::int64_t monotonic_us) const noexcept;
  [[nodiscard]] std::int64_t next_deadline_us() const noexcept;
  [[nodiscard]] std::vector<std::uint64_t> take_due(std::int64_t monotonic_us);
  [[nodiscard]] std::uint64_t next_slot() const noexcept { return next_slot_; }
  [[nodiscard]] bool paused() const noexcept { return pause_started_us_.has_value(); }
  [[nodiscard]] const std::vector<V4PauseInterval>& pause_intervals() const noexcept {
    return pause_intervals_;
  }

 private:
  std::int64_t started_us_{};
  std::int64_t paused_duration_us_{};
  std::optional<std::int64_t> pause_started_us_;
  std::uint64_t next_slot_{};
  std::vector<V4PauseInterval> pause_intervals_;
};

class V4FrameLedger final {
 public:
  void acknowledge(std::uint64_t slot, std::uint64_t source_sequence,
                   std::int64_t source_timestamp_us, std::int64_t submitted_at_us,
                   std::int64_t acknowledged_at_us, std::uint32_t in_flight);
  [[nodiscard]] const std::vector<V4FrameLedgerEntry>& entries() const noexcept { return entries_; }
  [[nodiscard]] std::uint64_t held_frames() const noexcept { return held_frames_; }
  [[nodiscard]] std::uint32_t ring_high_water_mark() const noexcept { return ring_high_water_mark_; }

 private:
  std::vector<V4FrameLedgerEntry> entries_;
  std::optional<std::uint64_t> source_origin_slot_;
  std::uint64_t last_source_sequence_{};
  std::uint64_t held_frames_{};
  std::uint32_t ring_high_water_mark_{};
};

}  // namespace storycapture::wgc
