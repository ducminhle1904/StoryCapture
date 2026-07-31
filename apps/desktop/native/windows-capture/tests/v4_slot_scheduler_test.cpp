#include <cassert>

#include "v4_slot_scheduler.hpp"

int main() {
  using storycapture::wgc::V4SlotScheduler;
  using storycapture::wgc::V4FrameLedger;
  using storycapture::wgc::v4_expected_frames;
  using storycapture::wgc::v4_pts_us;

  assert(v4_pts_us(0) == 0);
  assert(v4_pts_us(1) == 16'667);
  assert(v4_pts_us(2) == 33'333);
  assert(v4_expected_frames(8'333) == 0);
  assert(v4_expected_frames(8'334) == 1);
  assert(v4_expected_frames(1'000'000) == 60);

  V4SlotScheduler scheduler;
  scheduler.start(1'000'000);
  assert(scheduler.take_due(1'008'333).empty());
  auto first = scheduler.take_due(1'008'334);
  assert(first.size() == 1 && first.front() == 0);
  auto next = scheduler.take_due(1'041'667);
  assert(next.size() == 2 && next.front() == 1 && next.back() == 2);

  scheduler.pause(1'050'000);
  assert(scheduler.take_due(2'000'000).empty());
  scheduler.resume(2'050'000);
  assert(scheduler.active_time_us(2'050'000) == 50'000);
  assert(scheduler.pause_intervals().size() == 1);
  assert(scheduler.take_due(2'058'333).empty());
  auto after_pause = scheduler.take_due(2'058'334);
  assert(after_pause.size() == 1 && after_pause.front() == 3);

  V4FrameLedger ledger;
  ledger.acknowledge(0, 10, 1'000, 2'000, 2'100, 1);
  ledger.acknowledge(1, 10, 1'000, 18'667, 18'800, 2);
  ledger.acknowledge(2, 11, 34'000, 35'333, 35'500, 1);
  assert(ledger.entries().size() == 3);
  assert(!ledger.entries()[0].held_from_slot.has_value());
  assert(ledger.entries()[1].held_from_slot == 0);
  assert(!ledger.entries()[2].held_from_slot.has_value());
  assert(ledger.held_frames() == 1);
  assert(ledger.ring_high_water_mark() == 2);
  return 0;
}
