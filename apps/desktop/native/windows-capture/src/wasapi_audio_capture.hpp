#pragma once

#include <windows.h>

#include <atomic>
#include <cstdint>
#include <fstream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <audioclient.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

namespace storycapture::wgc {

enum class V4AudioRole { microphone, system };

struct V4AudioLedgerEntry {
  std::uint64_t sequence{};
  std::int64_t pts_us{};
  std::int64_t duration_us{};
  std::uint32_t frames{};
};

struct V4AudioEvidence {
  V4AudioRole role{};
  std::wstring artifact_path;
  std::wstring codec;
  std::uint32_t sample_rate_hz{};
  std::uint32_t channels{};
  std::int64_t started_offset_us{};
  std::int64_t duration_us{};
  std::int64_t end_drift_us{};
  std::int64_t sync_tolerance_us{20'000};
  bool pause_mapping_valid{true};
  std::uint64_t continuity_gaps{};
  std::vector<V4AudioLedgerEntry> ledger;
};

class WasapiAudioCapture final {
 public:
  WasapiAudioCapture(V4AudioRole role, std::wstring artifact_path, std::int64_t qpc_frequency);
  ~WasapiAudioCapture();

  WasapiAudioCapture(const WasapiAudioCapture&) = delete;
  WasapiAudioCapture& operator=(const WasapiAudioCapture&) = delete;

  void start(std::int64_t session_anchor_us);
  void set_paused(bool paused, std::int64_t monotonic_us);
  void stop(std::int64_t session_active_duration_us);
  [[nodiscard]] V4AudioEvidence evidence() const;

 private:
  void capture_loop(std::stop_token stop_token);
  [[nodiscard]] std::int64_t qpc_us() const noexcept;

  V4AudioRole role_;
  std::wstring artifact_path_;
  std::int64_t qpc_frequency_{};
  std::int64_t anchor_us_{};
  std::int64_t pause_started_us_{};
  std::int64_t paused_duration_us_{};
  std::int64_t expected_duration_us_{};
  std::atomic_bool paused_{};
  std::atomic_bool failed_{};
  HANDLE packet_event_{};
  WAVEFORMATEX* format_{};
  Microsoft::WRL::ComPtr<IMMDevice> device_;
  Microsoft::WRL::ComPtr<IAudioClient> client_;
  Microsoft::WRL::ComPtr<IAudioCaptureClient> capture_;
  std::jthread thread_;
  mutable std::mutex mutex_;
  std::ofstream output_;
  V4AudioEvidence evidence_;
};

[[nodiscard]] bool wasapi_role_available(V4AudioRole role) noexcept;

}  // namespace storycapture::wgc
