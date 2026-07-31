#include "v4_slot_scheduler.hpp"

#include <algorithm>
#include <stdexcept>

namespace storycapture::wgc {

void V4SlotScheduler::start(std::int64_t monotonic_us) {
  if (monotonic_us <= 0 || started_us_ != 0) throw std::logic_error("invalid V4 scheduler start");
  started_us_ = monotonic_us;
}

void V4SlotScheduler::pause(std::int64_t monotonic_us) {
  if (started_us_ == 0 || pause_started_us_ || monotonic_us < started_us_) {
    throw std::logic_error("invalid V4 scheduler pause");
  }
  pause_started_us_ = monotonic_us;
}

void V4SlotScheduler::resume(std::int64_t monotonic_us) {
  if (!pause_started_us_ || monotonic_us < *pause_started_us_) {
    throw std::logic_error("invalid V4 scheduler resume");
  }
  pause_intervals_.push_back({*pause_started_us_, monotonic_us});
  paused_duration_us_ += monotonic_us - *pause_started_us_;
  pause_started_us_.reset();
}

std::int64_t V4SlotScheduler::active_time_us(std::int64_t monotonic_us) const noexcept {
  if (started_us_ == 0 || monotonic_us <= started_us_) return 0;
  const auto open_pause = pause_started_us_ ? monotonic_us - *pause_started_us_ : 0;
  return std::max<std::int64_t>(0, monotonic_us - started_us_ - paused_duration_us_ - open_pause);
}

std::int64_t V4SlotScheduler::next_deadline_us() const noexcept {
  if (started_us_ == 0) return 0;
  const auto pause_shift = pause_started_us_ ? 0 : paused_duration_us_;
  return started_us_ + pause_shift + v4_pts_us(next_slot_);
}

std::vector<std::uint64_t> V4SlotScheduler::take_due(std::int64_t monotonic_us) {
  std::vector<std::uint64_t> result;
  if (started_us_ == 0 || pause_started_us_) return result;
  const auto expected = v4_expected_frames(active_time_us(monotonic_us));
  while (next_slot_ < expected) result.push_back(next_slot_++);
  return result;
}

void V4FrameLedger::acknowledge(std::uint64_t slot, std::uint64_t source_sequence,
                                std::int64_t source_timestamp_us,
                                std::int64_t submitted_at_us,
                                std::int64_t acknowledged_at_us,
                                std::uint32_t in_flight) {
  if (slot != entries_.size() || source_sequence == 0 || source_timestamp_us < 0 ||
      submitted_at_us < 0 || acknowledged_at_us < submitted_at_us || in_flight == 0) {
    throw std::logic_error("invalid V4 frame acknowledgement");
  }
  const bool held = !entries_.empty() && last_source_sequence_ == source_sequence;
  if (!held) source_origin_slot_ = slot;
  if (held) ++held_frames_;
  entries_.push_back({slot, v4_pts_us(slot), source_sequence, source_timestamp_us,
                      held ? source_origin_slot_ : std::nullopt, submitted_at_us,
                      acknowledged_at_us});
  last_source_sequence_ = source_sequence;
  ring_high_water_mark_ = std::max(ring_high_water_mark_, in_flight);
}

}  // namespace storycapture::wgc
