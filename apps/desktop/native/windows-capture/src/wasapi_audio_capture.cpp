#include "wasapi_audio_capture.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdlib>
#include <filesystem>
#include <stdexcept>

#include <functiondiscoverykeys_devpkey.h>
#include <ksmedia.h>
#include <winrt/base.h>

#include "protocol.hpp"

namespace storycapture::wgc {
namespace {

Microsoft::WRL::ComPtr<IMMDevice> default_device(V4AudioRole role) {
  Microsoft::WRL::ComPtr<IMMDeviceEnumerator> enumerator;
  winrt::check_hresult(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                        IID_PPV_ARGS(enumerator.ReleaseAndGetAddressOf())));
  Microsoft::WRL::ComPtr<IMMDevice> device;
  const auto flow = role == V4AudioRole::system ? eRender : eCapture;
  const auto result = enumerator->GetDefaultAudioEndpoint(flow, eConsole,
                                                           device.ReleaseAndGetAddressOf());
  if (FAILED(result)) throw ProtocolError("audio_device_unavailable", "requested WASAPI device is unavailable");
  return device;
}

bool is_float32(const WAVEFORMATEX* format) {
  if (format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) return format->wBitsPerSample == 32;
  if (format->wFormatTag != WAVE_FORMAT_EXTENSIBLE || format->cbSize < 22) return false;
  const auto* extensible = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format);
  return IsEqualGUID(extensible->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) &&
         format->wBitsPerSample == 32;
}

bool is_pcm16(const WAVEFORMATEX* format) {
  if (format->wFormatTag == WAVE_FORMAT_PCM) return format->wBitsPerSample == 16;
  if (format->wFormatTag != WAVE_FORMAT_EXTENSIBLE || format->cbSize < 22) return false;
  const auto* extensible = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format);
  return IsEqualGUID(extensible->SubFormat, KSDATAFORMAT_SUBTYPE_PCM) &&
         format->wBitsPerSample == 16;
}

}  // namespace

WasapiAudioCapture::WasapiAudioCapture(V4AudioRole role, std::wstring artifact_path,
                                       std::int64_t qpc_frequency)
    : role_(role), artifact_path_(std::move(artifact_path)), qpc_frequency_(qpc_frequency) {
  evidence_.role = role_;
  evidence_.artifact_path = artifact_path_;
}

WasapiAudioCapture::~WasapiAudioCapture() {
  try {
    stop(expected_duration_us_);
  } catch (...) {
  }
  if (format_) CoTaskMemFree(format_);
  if (packet_event_) CloseHandle(packet_event_);
}

void WasapiAudioCapture::start(std::int64_t session_anchor_us) {
  if (thread_.joinable()) throw ProtocolError("illegal_transition", "WASAPI capture already started");
  anchor_us_ = session_anchor_us;
  device_ = default_device(role_);
  winrt::check_hresult(device_->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                         reinterpret_cast<void**>(client_.ReleaseAndGetAddressOf())));
  winrt::check_hresult(client_->GetMixFormat(&format_));
  if (!is_float32(format_) && !is_pcm16(format_)) {
    throw ProtocolError("audio_format_invalid", "WASAPI mix format must be float32 or PCM16");
  }
  if (format_->nSamplesPerSec == 0 || format_->nChannels == 0 || format_->nBlockAlign == 0) {
    throw ProtocolError("audio_format_invalid", "WASAPI mix format is incomplete");
  }
  evidence_.codec = is_float32(format_) ? L"pcm_f32le" : L"pcm_s16le";
  evidence_.sample_rate_hz = format_->nSamplesPerSec;
  evidence_.channels = format_->nChannels;
  const DWORD flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                      (role_ == V4AudioRole::system ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0);
  winrt::check_hresult(client_->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 0, 0, format_, nullptr));
  packet_event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!packet_event_) throw winrt::hresult_error(HRESULT_FROM_WIN32(GetLastError()));
  winrt::check_hresult(client_->SetEventHandle(packet_event_));
  winrt::check_hresult(client_->GetService(IID_PPV_ARGS(capture_.ReleaseAndGetAddressOf())));
  std::filesystem::create_directories(std::filesystem::path(artifact_path_).parent_path());
  output_.open(std::filesystem::path(artifact_path_), std::ios::binary | std::ios::trunc);
  if (!output_) throw ProtocolError("audio_device_unavailable", "audio artifact could not be opened");
  winrt::check_hresult(client_->Start());
  thread_ = std::jthread([this](std::stop_token token) {
    try {
      capture_loop(token);
    } catch (...) {
      failed_.store(true);
    }
  });
}

void WasapiAudioCapture::set_paused(bool paused, std::int64_t monotonic_us) {
  std::scoped_lock lock(mutex_);
  if (paused) {
    if (paused_.exchange(true)) throw ProtocolError("illegal_transition", "audio capture already paused");
    pause_started_us_ = monotonic_us;
  } else {
    if (!paused_.exchange(false)) throw ProtocolError("illegal_transition", "audio capture is not paused");
    paused_duration_us_ += monotonic_us - pause_started_us_;
    pause_started_us_ = 0;
  }
}

void WasapiAudioCapture::stop(std::int64_t session_active_duration_us) {
  if (!thread_.joinable()) return;
  expected_duration_us_ = session_active_duration_us;
  thread_.request_stop();
  if (packet_event_) SetEvent(packet_event_);
  thread_.join();
  winrt::check_hresult(client_->Stop());
  output_.flush();
  output_.close();
  if (failed_) {
    throw ProtocolError("audio_continuity_failed", "WASAPI capture loop failed");
  }
  std::scoped_lock lock(mutex_);
  evidence_.end_drift_us = evidence_.duration_us - expected_duration_us_;
  if (std::abs(evidence_.started_offset_us) > evidence_.sync_tolerance_us ||
      std::abs(evidence_.end_drift_us) > evidence_.sync_tolerance_us) {
    throw ProtocolError("audio_sync_failed", "WASAPI stream drift exceeded the V4 tolerance");
  }
  if (evidence_.continuity_gaps != 0) {
    throw ProtocolError("audio_continuity_failed", "WASAPI packet continuity failed");
  }
}

V4AudioEvidence WasapiAudioCapture::evidence() const {
  std::scoped_lock lock(mutex_);
  return evidence_;
}

void WasapiAudioCapture::capture_loop(std::stop_token stop_token) {
  std::uint64_t total_frames = 0;
  while (!stop_token.stop_requested()) {
    if (WaitForSingleObject(packet_event_, 250) != WAIT_OBJECT_0) continue;
    for (;;) {
      UINT32 packet_frames = 0;
      winrt::check_hresult(capture_->GetNextPacketSize(&packet_frames));
      if (packet_frames == 0) break;
      BYTE* data = nullptr;
      DWORD flags = 0;
      UINT64 device_position = 0;
      UINT64 qpc_position = 0;
      winrt::check_hresult(capture_->GetBuffer(&data, &packet_frames, &flags, &device_position,
                                               &qpc_position));
      const auto packet_monotonic_us = qpc_position > 0
          ? static_cast<std::int64_t>(qpc_position / 10)
          : qpc_us();
      {
        std::scoped_lock lock(mutex_);
        if (!paused_.load()) {
          const auto pts_us = static_cast<std::int64_t>((total_frames * 1'000'000) /
                                                        format_->nSamplesPerSec);
          const auto duration_us = static_cast<std::int64_t>((packet_frames * 1'000'000LL) /
                                                             format_->nSamplesPerSec);
          if (evidence_.ledger.empty()) evidence_.started_offset_us = packet_monotonic_us - anchor_us_;
          if (!evidence_.ledger.empty()) {
            const auto& previous = evidence_.ledger.back();
            if (pts_us != previous.pts_us + previous.duration_us) ++evidence_.continuity_gaps;
          }
          if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) ++evidence_.continuity_gaps;
          if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
            std::vector<std::byte> silence(static_cast<std::size_t>(packet_frames) * format_->nBlockAlign);
            output_.write(reinterpret_cast<const char*>(silence.data()),
                          static_cast<std::streamsize>(silence.size()));
          } else {
            output_.write(reinterpret_cast<const char*>(data),
                          static_cast<std::streamsize>(packet_frames) * format_->nBlockAlign);
          }
          if (!output_) throw ProtocolError("audio_continuity_failed", "audio artifact write failed");
          evidence_.ledger.push_back({evidence_.ledger.size(), pts_us, duration_us, packet_frames});
          total_frames += packet_frames;
          evidence_.duration_us = static_cast<std::int64_t>((total_frames * 1'000'000) /
                                                            format_->nSamplesPerSec);
        }
      }
      winrt::check_hresult(capture_->ReleaseBuffer(packet_frames));
    }
  }
}

std::int64_t WasapiAudioCapture::qpc_us() const noexcept {
  LARGE_INTEGER value{};
  QueryPerformanceCounter(&value);
  return (value.QuadPart * 1'000'000) / qpc_frequency_;
}

bool wasapi_role_available(V4AudioRole role) noexcept {
  try {
    return default_device(role) != nullptr;
  } catch (...) {
    return false;
  }
}

}  // namespace storycapture::wgc
