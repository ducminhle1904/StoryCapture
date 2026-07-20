#include "capture_session.hpp"

#include <algorithm>
#include <chrono>
#include <format>
#include <sstream>

#include <dxgi1_6.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/base.h>

namespace storycapture::wgc {
namespace {

struct __declspec(uuid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1"))
    IDirect3DDxgiInterfaceAccess : IUnknown {
  virtual HRESULT __stdcall GetInterface(REFIID iid, void** object) = 0;
};

winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice make_winrt_device(
    ID3D11Device* device) {
  Microsoft::WRL::ComPtr<IDXGIDevice> dxgi_device;
  winrt::check_hresult(device->QueryInterface(IID_PPV_ARGS(dxgi_device.ReleaseAndGetAddressOf())));
  winrt::com_ptr<IInspectable> inspectable;
  winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi_device.Get(), inspectable.put()));
  return inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
}

Microsoft::WRL::ComPtr<ID3D11Texture2D> texture_from_surface(
    const winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DSurface& surface) {
  const auto access = surface.as<IDirect3DDxgiInterfaceAccess>();
  Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
  winrt::check_hresult(access->GetInterface(IID_PPV_ARGS(texture.ReleaseAndGetAddressOf())));
  return texture;
}

std::wstring luid_string(const LUID& luid) {
  return std::format(L"{:08x}:{:08x}", static_cast<std::uint32_t>(luid.HighPart), luid.LowPart);
}

}  // namespace

CaptureSession::CaptureSession(CaptureOptions options, EventWriter& writer, bool probe_only)
    : options_(std::move(options)), writer_(writer), probe_only_(probe_only), target_(resolve_target(options_.target)) {
  LARGE_INTEGER frequency{};
  QueryPerformanceFrequency(&frequency);
  qpc_frequency_ = frequency.QuadPart;
  adapter_ = adapter_for_target(target_);

  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
#if defined(_DEBUG)
  flags |= D3D11_CREATE_DEVICE_DEBUG;
#endif
  D3D_FEATURE_LEVEL feature_level{};
  constexpr D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_12_1, D3D_FEATURE_LEVEL_12_0,
                                          D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
  winrt::check_hresult(D3D11CreateDevice(adapter_.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags, levels,
                                        static_cast<UINT>(std::size(levels)), D3D11_SDK_VERSION,
                                        d3d_device_.ReleaseAndGetAddressOf(), &feature_level, nullptr));
  winrt_device_ = make_winrt_device(d3d_device_.Get());
  const winrt::Windows::Graphics::SizeInt32 size{static_cast<std::int32_t>(target_.width),
                                                 static_cast<std::int32_t>(target_.height)};
  frame_pool_ = winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
      winrt_device_, winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
      k_ring_capacity, size);
  capture_session_ = frame_pool_.CreateCaptureSession(target_.item);
  capture_session_.IsCursorCaptureEnabled(options_.cursor_policy == CursorPolicy::include);
  if (!probe_only_) {
    ring_ = std::make_unique<NativeFrameRing>(d3d_device_.Get(), options_.session_id,
                                              options_.ownership_token, target_.width, target_.height);
  }
  observation_.physical_width = target_.width;
  observation_.physical_height = target_.height;
  observation_.gpu_identity = gpu_identity();
  observation_.adapter_luid = adapter_luid();
  observation_.hardware_fingerprint = hardware_fingerprint();
  observation_.permissions_granted = true;
}

CaptureSession::~CaptureSession() { stop(); }

void CaptureSession::start() {
  if (running_.exchange(true)) throw ProtocolError("contract_mismatch", "capture session already started");
  if (target_.width < options_.requested_width || target_.height < options_.requested_height) {
    running_ = false;
    throw ProtocolError("backend_capability_mismatch", "physical target is smaller than requested output");
  }
  frame_token_ = frame_pool_.FrameArrived({this, &CaptureSession::on_frame_arrived});
  closed_token_ = target_.item.Closed({this, &CaptureSession::on_target_closed});
  {
    std::scoped_lock lock(mutex_);
    last_frame_qpc_us_ = qpc_us();
  }
  capture_session_.StartCapture();
  watchdog_ = std::jthread([this](std::stop_token token) { watchdog(token); });
}

void CaptureSession::pause() {
  if (!running_ || failed_) throw ProtocolError("contract_mismatch", "capture session is not active");
  std::scoped_lock lock(mutex_);
  if (paused_.exchange(true)) throw ProtocolError("contract_mismatch", "capture session already paused");
  pause_started_qpc_us_ = qpc_us();
}

void CaptureSession::resume() {
  if (!running_ || failed_) throw ProtocolError("contract_mismatch", "capture session is not active");
  std::scoped_lock lock(mutex_);
  if (!paused_.load()) throw ProtocolError("contract_mismatch", "capture session is not paused");
  const auto resumed_qpc_us = qpc_us();
  paused_duration_us_ += resumed_qpc_us - pause_started_qpc_us_;
  last_frame_qpc_us_ = resumed_qpc_us;
  paused_.store(false);
}

void CaptureSession::stop() {
  if (!running_.exchange(false)) return;
  watchdog_.request_stop();
  if (watchdog_.joinable() && watchdog_.get_id() != std::this_thread::get_id()) watchdog_.join();
  if (frame_pool_) frame_pool_.FrameArrived(frame_token_);
  if (target_.item) target_.item.Closed(closed_token_);
  if (capture_session_) capture_session_.Close();
  if (frame_pool_) frame_pool_.Close();
  capture_session_ = nullptr;
  frame_pool_ = nullptr;
}

ProbeObservation CaptureSession::observation() const {
  std::scoped_lock lock(mutex_);
  return observation_;
}

std::wstring CaptureSession::gpu_identity() const {
  DXGI_ADAPTER_DESC1 description{};
  winrt::check_hresult(adapter_->GetDesc1(&description));
  return std::format(L"{} [vendor={:04x}, device={:04x}]", description.Description,
                     description.VendorId, description.DeviceId);
}

std::wstring CaptureSession::adapter_luid() const {
  DXGI_ADAPTER_DESC1 description{};
  winrt::check_hresult(adapter_->GetDesc1(&description));
  return luid_string(description.AdapterLuid);
}

std::wstring CaptureSession::hardware_fingerprint() const {
  DXGI_ADAPTER_DESC1 description{};
  winrt::check_hresult(adapter_->GetDesc1(&description));
  return std::format(L"wgc:{}:{:04x}:{:04x}:{}", target_.stable_identity, description.VendorId,
                     description.DeviceId, luid_string(description.AdapterLuid));
}

void CaptureSession::on_frame_arrived(
    const winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool& sender,
    const winrt::Windows::Foundation::IInspectable&) {
  if (!running_ || failed_) return;
  try {
    const auto frame = sender.TryGetNextFrame();
    if (!frame) return;
    const auto source_size = frame.ContentSize();
    if (source_size.Width != static_cast<std::int32_t>(target_.width) ||
        source_size.Height != static_cast<std::int32_t>(target_.height)) {
      JsonObject event;
      set_string(event, L"type", L"format-changed");
      set_string(event, L"session_id", options_.session_id);
      set_number(event, L"width", source_size.Width);
      set_number(event, L"height", source_size.Height);
      writer_.emit(std::move(event));
      terminal_failure(L"target_changed", L"capture target physical size changed");
      return;
    }
    const auto source_time = frame.SystemRelativeTime();
    if (!source_time) throw ProtocolError("contract_mismatch", "WGC frame has no native timestamp");
    const auto source_pts_us = source_time.Value().count() / 10;
    std::scoped_lock lock(mutex_);
    last_frame_qpc_us_ = qpc_us();
    ++source_frame_index_;
    ++observation_.source_presentations;
    if (observation_.first_pts_us < 0) observation_.first_pts_us = source_pts_us;
    if (last_source_pts_us_ >= 0) {
      const auto delta = source_pts_us - last_source_pts_us_;
      if (delta <= 0) {
        ++observation_.stale_reuses;
      } else if (delta > 25'000) {
        observation_.sequence_gaps +=
            static_cast<std::uint64_t>(std::max<std::int64_t>(1, (delta * 60) / 1'000'000 - 1));
      }
    }
    last_source_pts_us_ = source_pts_us;
    observation_.last_pts_us = source_pts_us;
    if (paused_ || probe_only_) return;
    if (source_frame_index_ % 60 == 0 && !target_identity_matches(target_)) {
      terminal_failure(L"target_changed", L"capture target identity changed");
      return;
    }
    if (first_source_pts_us_ < 0) first_source_pts_us_ = source_pts_us;
    const auto active_pts_us = source_pts_us - first_source_pts_us_ - paused_duration_us_;
    const auto duration_us = previous_active_pts_us_ < 0 ? 16'667 : active_pts_us - previous_active_pts_us_;
    if (active_pts_us < 0 || duration_us <= 0) {
      terminal_failure(L"source_stale_reuse", L"native presentation timestamp did not advance");
      return;
    }
    const auto texture = texture_from_surface(frame.Surface());
    const auto committed = ring_->commit(texture.Get(), source_frame_index_, active_pts_us, duration_us);
    previous_active_pts_us_ = active_pts_us;

    JsonObject event;
    set_string(event, L"type", L"frame-committed");
    set_string(event, L"session_id", options_.session_id);
    set_number(event, L"delivery_sequence", static_cast<double>(committed.delivery_sequence));
    set_number(event, L"source_frame_index", static_cast<double>(committed.source_frame_index));
    set_number(event, L"native_pts_us", static_cast<double>(committed.native_pts_us));
    set_number(event, L"duration_us", static_cast<double>(committed.duration_us));
    set_number(event, L"slot_index", committed.slot_index);
    set_number(event, L"width", committed.width);
    set_number(event, L"height", committed.height);
    set_number(event, L"stride", committed.stride);
    set_string(event, L"pixel_format", L"bgra");
    set_string(event, L"ownership_token", options_.ownership_token);
    writer_.emit(std::move(event));
  } catch (const ProtocolError& error) {
    terminal_failure(widen(error.failure_code()), widen(error.what()));
  } catch (const winrt::hresult_error& error) {
    terminal_failure(L"backend_unavailable", error.message().c_str());
  } catch (const std::exception& error) {
    terminal_failure(L"backend_unavailable", widen(error.what()));
  }
}

void CaptureSession::on_target_closed(
    const winrt::Windows::Graphics::Capture::GraphicsCaptureItem&,
    const winrt::Windows::Foundation::IInspectable&) {
  if (!running_) return;
  JsonObject event;
  set_string(event, L"type", L"target-lost");
  set_string(event, L"session_id", options_.session_id);
  set_string(event, L"failure_code", L"target_lost");
  writer_.emit(std::move(event));
  terminal_failure(L"target_lost", L"Windows Graphics Capture target closed");
}

void CaptureSession::terminal_failure(std::wstring_view code, std::wstring_view message) noexcept {
  if (failed_.exchange(true)) return;
  if (ring_) ring_->fail();
  writer_.failure(options_.session_id, code, message);
}

void CaptureSession::watchdog(std::stop_token stop_token) {
  while (!stop_token.stop_requested()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
    if (!running_ || probe_only_) continue;
    bool paused = false;
    std::int64_t last_frame_qpc_us = 0;
    {
      std::scoped_lock lock(mutex_);
      paused = paused_.load();
      last_frame_qpc_us = last_frame_qpc_us_;
    }
    if (paused) continue;
    if (qpc_us() - last_frame_qpc_us > 2'000'000) {
      terminal_failure(L"source_rate_mismatch", L"WGC stopped presenting source frames");
      return;
    }
  }
}

std::int64_t CaptureSession::qpc_us() const noexcept {
  LARGE_INTEGER value{};
  QueryPerformanceCounter(&value);
  return (value.QuadPart * 1'000'000) / qpc_frequency_;
}

}  // namespace storycapture::wgc
