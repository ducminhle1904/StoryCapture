#include "capture_session.hpp"

#include <algorithm>
#include <chrono>
#include <format>
#include <filesystem>
#include <sstream>

#include <dxgi1_6.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/base.h>

namespace storycapture::wgc {
namespace {

constexpr std::int32_t k_capture_frame_pool_size = 8;

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

CaptureSession::CaptureSession(RecordingV4Options options, EventWriter& writer)
    : options_(std::move(options)), writer_(writer), target_(resolve_target(options_.target)) {
  if (_wcsicmp(target_.stable_identity.c_str(), options_.target_stable_id.c_str()) != 0) {
    throw ProtocolError("target_changed", "V4 target stable identity does not match");
  }
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
  Microsoft::WRL::ComPtr<ID3D11Multithread> multithread;
  winrt::check_hresult(
      d3d_device_->QueryInterface(IID_PPV_ARGS(multithread.ReleaseAndGetAddressOf())));
  multithread->SetMultithreadProtected(TRUE);
  winrt_device_ = make_winrt_device(d3d_device_.Get());
  const winrt::Windows::Graphics::SizeInt32 size{static_cast<std::int32_t>(target_.width),
                                                 static_cast<std::int32_t>(target_.height)};
  frame_pool_ = winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
      winrt_device_, winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
      k_capture_frame_pool_size, size);
  capture_session_ = frame_pool_.CreateCaptureSession(target_.item);
  capture_session_.IsCursorCaptureEnabled(options_.cursor_policy == CursorPolicy::include);
  if (target_.width != options_.requested_width || target_.height != options_.requested_height) {
    throw ProtocolError("surface_not_1080p", "recording dimensions must match the exact WGC surface");
  }
  mp4_writer_ = std::make_unique<NativeMp4Writer>(
      d3d_device_.Get(), options_.output_path, target_.width, target_.height,
      options_.target_bitrate_bps);
  if (mp4_writer_->encoder_id() != options_.encoder_envelope_id) {
    throw ProtocolError("hardware_encoder_unavailable",
                        "calibrated encoder identity does not match the selected MFT");
  }
  const auto audio_root = std::filesystem::path(options_.output_path).parent_path();
  if (options_.microphone_audio) {
    audio_captures_.push_back(std::make_unique<WasapiAudioCapture>(
        V4AudioRole::microphone, (audio_root / L"microphone.pcm").wstring(), qpc_frequency_));
  }
  if (options_.system_audio) {
    audio_captures_.push_back(std::make_unique<WasapiAudioCapture>(
        V4AudioRole::system, (audio_root / L"system.pcm").wstring(), qpc_frequency_));
  }
}

CaptureSession::~CaptureSession() {
  try {
    stop();
  } catch (...) {
  }
}

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
    started_monotonic_us_ = qpc_us();
    last_frame_qpc_us_ = started_monotonic_us_;
    slot_scheduler_.start(started_monotonic_us_);
  }
  for (auto& audio : audio_captures_) audio->start(started_monotonic_us_);
  capture_session_.StartCapture();
  watchdog_ = std::jthread([this](std::stop_token token) { watchdog(token); });
  slot_scheduler_thread_ = std::jthread([this](std::stop_token token) { v4_scheduler_loop(token); });
}

void CaptureSession::wait_for_initial_surface(std::chrono::milliseconds timeout) {
  if (!mp4_writer_) {
    throw ProtocolError("contract_mismatch", "initial-surface readiness requires native MP4");
  }
  std::unique_lock lock(mutex_);
  if (!initial_surface_cv_.wait_for(lock, timeout,
                                    [this] { return latest_texture_ != nullptr || failed_.load(); })) {
    throw ProtocolError("initial_surface_missing",
                        "WGC did not produce the first encoded surface before timeout");
  }
  if (failed_) {
    throw ProtocolError("initial_surface_missing",
                        "WGC failed before the first surface could be encoded");
  }
}

void CaptureSession::pause() {
  if (!running_ || failed_) throw ProtocolError("contract_mismatch", "capture session is not active");
  std::scoped_lock lock(mutex_);
  if (paused_.exchange(true)) throw ProtocolError("contract_mismatch", "capture session already paused");
  pause_started_qpc_us_ = qpc_us();
  slot_scheduler_.pause(pause_started_qpc_us_);
  for (auto& audio : audio_captures_) audio->set_paused(true, pause_started_qpc_us_);
}

void CaptureSession::resume() {
  if (!running_ || failed_) throw ProtocolError("contract_mismatch", "capture session is not active");
  std::scoped_lock lock(mutex_);
  if (!paused_.load()) throw ProtocolError("contract_mismatch", "capture session is not paused");
  const auto resumed_qpc_us = qpc_us();
  paused_duration_us_ += resumed_qpc_us - pause_started_qpc_us_;
  last_frame_qpc_us_ = resumed_qpc_us;
  slot_scheduler_.resume(resumed_qpc_us);
  for (auto& audio : audio_captures_) audio->set_paused(false, resumed_qpc_us);
  paused_.store(false);
}

void CaptureSession::stop() {
  if (!running_.exchange(false)) return;
  watchdog_.request_stop();
  slot_scheduler_thread_.request_stop();
  if (watchdog_.joinable() && watchdog_.get_id() != std::this_thread::get_id()) watchdog_.join();
  if (slot_scheduler_thread_.joinable() &&
      slot_scheduler_thread_.get_id() != std::this_thread::get_id()) {
    slot_scheduler_thread_.join();
  }
  if (frame_pool_) frame_pool_.FrameArrived(frame_token_);
  if (target_.item) target_.item.Closed(closed_token_);
  if (capture_session_) capture_session_.Close();
  if (frame_pool_) frame_pool_.Close();
  capture_session_ = nullptr;
  frame_pool_ = nullptr;
  std::scoped_lock lock(mutex_);
  ended_monotonic_us_ = qpc_us();
  if (slot_scheduler_.paused()) {
    slot_scheduler_.resume(ended_monotonic_us_);
  }
  if (mp4_writer_ && latest_texture_ && !failed_) {
    const auto paused_tail = paused_ ? ended_monotonic_us_ - pause_started_qpc_us_ : 0;
  const auto active_duration_us =
        ended_monotonic_us_ - started_monotonic_us_ - paused_duration_us_ - paused_tail;
    const auto expected_frames = v4_expected_frames(active_duration_us);
    while (output_frame_index_ < expected_frames) {
      write_v4_slot(output_frame_index_, qpc_us());
    }
    for (auto& audio : audio_captures_) audio->stop(active_duration_us);
  }
}

RecordingV4Evidence CaptureSession::finalize() {
  if (!mp4_writer_) throw ProtocolError("contract_mismatch", "native MP4 writer is not active");
  if (running_) throw ProtocolError("contract_mismatch", "capture must stop before finalization");
  if (!latest_texture_ || output_frame_index_ == 0) {
    throw ProtocolError("initial_surface_missing", "WGC produced no encodable surface");
  }
  mp4_writer_->finalize();
  RecordingV4Evidence evidence;
  evidence.artifact_path = mp4_writer_->output_path();
  evidence.encoder_id = mp4_writer_->encoder_id();
  evidence.width = target_.width;
  evidence.height = target_.height;
  evidence.source_frames = source_frame_index_;
  evidence.output_frames = output_frame_index_;
  evidence.held_frames = held_frames_;
  evidence.encoder_dropped_frames = encoder_dropped_frames_;
  evidence.initial_surface_received = latest_texture_ != nullptr;
  evidence.started_monotonic_us = started_monotonic_us_;
  evidence.ended_monotonic_us = ended_monotonic_us_;
  evidence.finalized_duration_us =
      static_cast<std::int64_t>((output_frame_index_ * 1'000'000) / 60);
  evidence.requested_bitrate_bps = mp4_writer_->requested_bitrate_bps();
  evidence.artifact_bytes = mp4_writer_->artifact_bytes();
  evidence.average_bitrate_bps = mp4_writer_->average_bitrate_bps();
  evidence.peak_bitrate_bps = mp4_writer_->peak_bitrate_bps();
  evidence.ring_high_water_mark = v4_frame_ledger_.ring_high_water_mark();
  evidence.frame_ledger = v4_frame_ledger_.entries();
  evidence.pause_intervals = slot_scheduler_.pause_intervals();
  for (const auto& audio : audio_captures_) evidence.audio.push_back(audio->evidence());
  return evidence;
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
      terminal_failure(L"target_changed", L"capture target physical size changed");
      return;
    }
    const auto source_time = frame.SystemRelativeTime();
    if (!source_time) throw ProtocolError("contract_mismatch", "WGC frame has no native timestamp");
    const auto source_pts_us = source_time.Value().count() / 10;
    std::scoped_lock lock(mutex_);
    last_frame_qpc_us_ = qpc_us();
    ++source_frame_index_;
    if (paused_) return;
    if (source_frame_index_ % 60 == 0 && !target_identity_matches(target_)) {
      terminal_failure(L"target_changed", L"capture target identity changed");
      return;
    }
    const auto texture = texture_from_surface(frame.Surface());
    D3D11_TEXTURE2D_DESC descriptor{};
    texture->GetDesc(&descriptor);
    descriptor.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    descriptor.CPUAccessFlags = 0;
    descriptor.MiscFlags = 0;
    descriptor.Usage = D3D11_USAGE_DEFAULT;
    if (!latest_texture_) {
      winrt::check_hresult(d3d_device_->CreateTexture2D(
          &descriptor, nullptr, latest_texture_.ReleaseAndGetAddressOf()));
    }
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
    d3d_device_->GetImmediateContext(context.ReleaseAndGetAddressOf());
    context->CopyResource(latest_texture_.Get(), texture.Get());
    latest_source_sequence_ = source_frame_index_;
    latest_source_timestamp_us_ = source_pts_us;
    initial_surface_cv_.notify_all();
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
  terminal_failure(L"target_lost", L"Windows Graphics Capture target closed");
}

void CaptureSession::terminal_failure(std::wstring_view code, std::wstring_view message) noexcept {
  if (failed_.exchange(true)) return;
  initial_surface_cv_.notify_all();
  if (code == L"source_rate_mismatch" || code == L"source_stale_reuse") code = L"target_lost";
  if (code == L"backend_unavailable") code = L"helper_unavailable";
  if (code == L"encoder_unavailable") code = L"hardware_encoder_unavailable";
  writer_.failure(options_.session_id, code, message);
}

void CaptureSession::watchdog(std::stop_token stop_token) {
  while (!stop_token.stop_requested()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
    if (!running_) continue;
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

void CaptureSession::v4_scheduler_loop(std::stop_token stop_token) {
  while (!stop_token.stop_requested()) {
    try {
      const auto now = qpc_us();
      {
        std::scoped_lock lock(mutex_);
        if (!paused_ && latest_texture_) {
          for (const auto slot : slot_scheduler_.take_due(now)) write_v4_slot(slot, qpc_us());
        }
      }
    } catch (const ProtocolError& error) {
      terminal_failure(widen(error.failure_code()), widen(error.what()));
      return;
    } catch (const winrt::hresult_error& error) {
      terminal_failure(L"encoder_rejected_frame", error.message().c_str());
      return;
    } catch (const std::exception& error) {
      terminal_failure(L"encoder_rejected_frame", widen(error.what()));
      return;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
}

void CaptureSession::write_v4_slot(std::uint64_t slot, std::int64_t submitted_at_us) {
  if (!latest_texture_) return;
  if (slot != output_frame_index_) {
    throw ProtocolError("frame_slot_missing", "V4 slot scheduler produced a non-contiguous slot");
  }
  mp4_writer_->write(latest_texture_.Get(), slot);
  const auto acknowledged_at_us = qpc_us();
  v4_frame_ledger_.acknowledge(slot, latest_source_sequence_, latest_source_timestamp_us_,
                               submitted_at_us, acknowledged_at_us, 1);
  held_frames_ = v4_frame_ledger_.held_frames();
  ++output_frame_index_;
}

std::int64_t CaptureSession::qpc_us() const noexcept {
  LARGE_INTEGER value{};
  QueryPerformanceCounter(&value);
  return (value.QuadPart * 1'000'000) / qpc_frequency_;
}

}  // namespace storycapture::wgc
