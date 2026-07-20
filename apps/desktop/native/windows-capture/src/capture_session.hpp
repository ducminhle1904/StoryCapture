#pragma once

#include <windows.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <thread>

#include <d3d11.h>
#include <wrl/client.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include "capture_types.hpp"
#include "frame_ring.hpp"
#include "protocol.hpp"
#include "target_resolver.hpp"

namespace storycapture::wgc {

class CaptureSession final {
 public:
  CaptureSession(CaptureOptions options, EventWriter& writer, bool probe_only);
  ~CaptureSession();

  CaptureSession(const CaptureSession&) = delete;
  CaptureSession& operator=(const CaptureSession&) = delete;

  void start();
  void pause();
  void resume();
  void stop();

  [[nodiscard]] ProbeObservation observation() const;
  [[nodiscard]] const NativeFrameRing* ring() const noexcept { return ring_.get(); }
  [[nodiscard]] std::wstring gpu_identity() const;
  [[nodiscard]] std::wstring adapter_luid() const;
  [[nodiscard]] std::wstring hardware_fingerprint() const;

 private:
  void on_frame_arrived(
      const winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool& sender,
      const winrt::Windows::Foundation::IInspectable&);
  void on_target_closed(const winrt::Windows::Graphics::Capture::GraphicsCaptureItem&,
                        const winrt::Windows::Foundation::IInspectable&);
  void terminal_failure(std::wstring_view code, std::wstring_view message) noexcept;
  void watchdog(std::stop_token stop_token);
  std::int64_t qpc_us() const noexcept;

  CaptureOptions options_;
  EventWriter& writer_;
  bool probe_only_{};
  ResolvedCaptureTarget target_;
  Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter_;
  Microsoft::WRL::ComPtr<ID3D11Device> d3d_device_;
  winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice winrt_device_{nullptr};
  winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool frame_pool_{nullptr};
  winrt::Windows::Graphics::Capture::GraphicsCaptureSession capture_session_{nullptr};
  std::unique_ptr<NativeFrameRing> ring_;
  winrt::event_token frame_token_{};
  winrt::event_token closed_token_{};
  std::jthread watchdog_;
  mutable std::mutex mutex_;
  std::atomic_bool running_{};
  std::atomic_bool paused_{};
  std::atomic_bool failed_{};
  std::int64_t qpc_frequency_{};
  std::int64_t last_frame_qpc_us_{};
  std::int64_t pause_started_qpc_us_{};
  std::int64_t paused_duration_us_{};
  std::int64_t first_source_pts_us_{-1};
  std::int64_t last_source_pts_us_{-1};
  std::int64_t previous_active_pts_us_{-1};
  std::uint64_t source_frame_index_{};
  ProbeObservation observation_;
};

}  // namespace storycapture::wgc
