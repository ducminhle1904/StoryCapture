#pragma once

#include <windows.h>

#include <string>

#include <dxgi1_6.h>
#include <wrl/client.h>
#include <winrt/Windows.Graphics.Capture.h>

#include "capture_types.hpp"

namespace storycapture::wgc {

struct ResolvedCaptureTarget {
  CaptureTarget requested;
  winrt::Windows::Graphics::Capture::GraphicsCaptureItem item{nullptr};
  HMONITOR monitor{};
  HWND window{};
  std::uint32_t width{};
  std::uint32_t height{};
  std::wstring stable_identity;
};

ResolvedCaptureTarget resolve_target(const CaptureTarget& target);
bool target_identity_matches(const ResolvedCaptureTarget& target) noexcept;
Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter_for_target(const ResolvedCaptureTarget& target);
std::wstring process_image_path(std::uint32_t process_id);

}  // namespace storycapture::wgc
