#include "target_resolver.hpp"

#include <algorithm>
#include <cwctype>
#include <filesystem>
#include <stdexcept>
#include <vector>

#include <winrt/base.h>

#include "protocol.hpp"

namespace storycapture::wgc {
namespace {

struct __declspec(uuid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"))
    IGraphicsCaptureItemInterop : IUnknown {
  virtual HRESULT __stdcall CreateForWindow(HWND window, REFIID iid, void** result) = 0;
  virtual HRESULT __stdcall CreateForMonitor(HMONITOR monitor, REFIID iid, void** result) = 0;
};

bool equal_identity(std::wstring_view left, std::wstring_view right) {
  if (left.size() != right.size()) return false;
  return std::equal(left.begin(), left.end(), right.begin(), [](wchar_t a, wchar_t b) {
    return std::towlower(a) == std::towlower(b);
  });
}

struct DisplayCandidate {
  HMONITOR monitor{};
  std::wstring display_name;
  std::wstring device_id;
  std::wstring device_key;
};

BOOL CALLBACK collect_monitor(HMONITOR monitor, HDC, LPRECT, LPARAM context) {
  auto* candidates = reinterpret_cast<std::vector<DisplayCandidate>*>(context);
  MONITORINFOEXW monitor_info{};
  monitor_info.cbSize = sizeof(monitor_info);
  if (!GetMonitorInfoW(monitor, &monitor_info)) return TRUE;
  DISPLAY_DEVICEW device{};
  device.cb = sizeof(device);
  if (!EnumDisplayDevicesW(monitor_info.szDevice, 0, &device, EDD_GET_DEVICE_INTERFACE_NAME)) {
    return TRUE;
  }
  candidates->push_back({monitor, monitor_info.szDevice, device.DeviceID, device.DeviceKey});
  return TRUE;
}

std::vector<DisplayCandidate> enumerate_displays() {
  std::vector<DisplayCandidate> candidates;
  if (!EnumDisplayMonitors(nullptr, nullptr, collect_monitor,
                           reinterpret_cast<LPARAM>(&candidates))) {
    throw winrt::hresult_error(HRESULT_FROM_WIN32(GetLastError()));
  }
  return candidates;
}

winrt::Windows::Graphics::Capture::GraphicsCaptureItem item_for_window(HWND window) {
  const auto interop = winrt::get_activation_factory<
      winrt::Windows::Graphics::Capture::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  winrt::Windows::Graphics::Capture::GraphicsCaptureItem item{nullptr};
  winrt::check_hresult(interop->CreateForWindow(window, winrt::guid_of<decltype(item)>(),
                                               winrt::put_abi(item)));
  return item;
}

winrt::Windows::Graphics::Capture::GraphicsCaptureItem item_for_monitor(HMONITOR monitor) {
  const auto interop = winrt::get_activation_factory<
      winrt::Windows::Graphics::Capture::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  winrt::Windows::Graphics::Capture::GraphicsCaptureItem item{nullptr};
  winrt::check_hresult(interop->CreateForMonitor(monitor, winrt::guid_of<decltype(item)>(),
                                                winrt::put_abi(item)));
  return item;
}

std::wstring window_class(HWND window) {
  std::wstring buffer(512, L'\0');
  const auto length = GetClassNameW(window, buffer.data(), static_cast<int>(buffer.size()));
  if (length <= 0) throw winrt::hresult_error(HRESULT_FROM_WIN32(GetLastError()));
  buffer.resize(static_cast<std::size_t>(length));
  return buffer;
}

}  // namespace

std::wstring process_image_path(std::uint32_t process_id) {
  const auto process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);
  if (!process) throw ProtocolError("target_missing", "capture target process is unavailable");
  std::wstring buffer(32'768, L'\0');
  DWORD length = static_cast<DWORD>(buffer.size());
  const auto succeeded = QueryFullProcessImageNameW(process, 0, buffer.data(), &length);
  CloseHandle(process);
  if (!succeeded) throw ProtocolError("target_missing", "capture target executable is unavailable");
  buffer.resize(length);
  return std::filesystem::path(buffer).lexically_normal().wstring();
}

ResolvedCaptureTarget resolve_target(const CaptureTarget& target) {
  if (!winrt::Windows::Graphics::Capture::GraphicsCaptureSession::IsSupported()) {
    throw ProtocolError("backend_unavailable", "Windows Graphics Capture is not supported");
  }
  if (target.kind == TargetKind::display) {
    const auto displays = enumerate_displays();
    std::vector<DisplayCandidate> matches;
    std::copy_if(displays.begin(), displays.end(), std::back_inserter(matches), [&](const auto& item) {
      return equal_identity(item.display_name, target.device_path) ||
             equal_identity(item.device_id, target.device_path) ||
             equal_identity(item.device_key, target.device_path);
    });
    if (matches.empty()) throw ProtocolError("target_missing", "display identity was not found");
    if (matches.size() != 1) throw ProtocolError("target_ambiguous", "display identity is ambiguous");
    auto item = item_for_monitor(matches.front().monitor);
    const auto size = item.Size();
    return {
        .requested = target,
        .item = item,
        .monitor = matches.front().monitor,
        .window = nullptr,
        .width = static_cast<std::uint32_t>(size.Width),
        .height = static_cast<std::uint32_t>(size.Height),
        .stable_identity = matches.front().device_id,
    };
  }

  const auto window = reinterpret_cast<HWND>(static_cast<std::uintptr_t>(target.hwnd));
  if (!IsWindow(window)) throw ProtocolError("target_missing", "window identity was not found");
  DWORD process_id = 0;
  GetWindowThreadProcessId(window, &process_id);
  if (process_id != target.process_id ||
      !equal_identity(process_image_path(process_id), target.executable_path) ||
      !equal_identity(window_class(window), target.class_name)) {
    throw ProtocolError("target_changed", "window identity no longer matches the selected target");
  }
  auto item = item_for_window(window);
  const auto size = item.Size();
  return {
      .requested = target,
      .item = item,
      .monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST),
      .window = window,
      .width = static_cast<std::uint32_t>(size.Width),
      .height = static_cast<std::uint32_t>(size.Height),
      .stable_identity = target.executable_path + L"|" + target.class_name,
  };
}

bool target_identity_matches(const ResolvedCaptureTarget& target) noexcept {
  try {
    if (target.requested.kind == TargetKind::display) {
      const auto displays = enumerate_displays();
      return std::count_if(displays.begin(), displays.end(), [&](const auto& display) {
               return equal_identity(display.device_id, target.stable_identity);
             }) == 1;
    }
    if (!IsWindow(target.window)) return false;
    DWORD process_id = 0;
    GetWindowThreadProcessId(target.window, &process_id);
    return process_id == target.requested.process_id &&
           equal_identity(process_image_path(process_id), target.requested.executable_path) &&
           equal_identity(window_class(target.window), target.requested.class_name);
  } catch (...) {
    return false;
  }
}

Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter_for_target(const ResolvedCaptureTarget& target) {
  Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
  winrt::check_hresult(CreateDXGIFactory1(IID_PPV_ARGS(factory.ReleaseAndGetAddressOf())));
  for (UINT adapter_index = 0;; ++adapter_index) {
    Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
    if (factory->EnumAdapters1(adapter_index, adapter.ReleaseAndGetAddressOf()) == DXGI_ERROR_NOT_FOUND) {
      break;
    }
    for (UINT output_index = 0;; ++output_index) {
      Microsoft::WRL::ComPtr<IDXGIOutput> output;
      if (adapter->EnumOutputs(output_index, output.ReleaseAndGetAddressOf()) == DXGI_ERROR_NOT_FOUND) {
        break;
      }
      DXGI_OUTPUT_DESC description{};
      winrt::check_hresult(output->GetDesc(&description));
      if (description.Monitor == target.monitor) return adapter;
    }
  }
  throw ProtocolError("backend_unavailable", "no D3D adapter owns the capture target");
}

}  // namespace storycapture::wgc
