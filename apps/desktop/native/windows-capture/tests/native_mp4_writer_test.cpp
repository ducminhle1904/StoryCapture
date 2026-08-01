#include <windows.h>

#include <cstdint>
#include <filesystem>
#include <format>
#include <vector>

#include <d3d11.h>
#include <mfapi.h>
#include <mfreadwrite.h>
#include <wrl/client.h>
#include <winrt/base.h>

#include "native_mp4_writer.hpp"

namespace {

constexpr std::uint32_t k_width = 320;
constexpr std::uint32_t k_height = 180;
constexpr std::uint32_t k_frames = 6;
constexpr std::uint32_t k_target_bitrate_bps = 12'000'000;

}  // namespace

int wmain() {
  winrt::init_apartment(winrt::apartment_type::multi_threaded);
  const auto output = std::filesystem::temp_directory_path() /
                      std::format(L"storycapture-wgc-native-{}.mp4", GetCurrentProcessId());
  std::error_code ignored;
  std::filesystem::remove(output, ignored);
  try {
    Microsoft::WRL::ComPtr<ID3D11Device> device;
    winrt::check_hresult(D3D11CreateDevice(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, nullptr, 0,
        D3D11_SDK_VERSION, device.ReleaseAndGetAddressOf(), nullptr, nullptr));
    std::vector<std::uint32_t> pixels(k_width * k_height, 0xff336699);
    D3D11_SUBRESOURCE_DATA initial{pixels.data(), k_width * 4, 0};
    D3D11_TEXTURE2D_DESC descriptor{};
    descriptor.Width = k_width;
    descriptor.Height = k_height;
    descriptor.MipLevels = 1;
    descriptor.ArraySize = 1;
    descriptor.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    descriptor.SampleDesc.Count = 1;
    descriptor.Usage = D3D11_USAGE_DEFAULT;
    descriptor.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
    winrt::check_hresult(
        device->CreateTexture2D(&descriptor, &initial, texture.ReleaseAndGetAddressOf()));
    {
      storycapture::wgc::NativeMp4Writer writer(device.Get(), output.wstring(), k_width, k_height,
                                                 k_target_bitrate_bps);
      if (writer.requested_bitrate_bps() != k_target_bitrate_bps) return 3;
      for (std::uint64_t frame = 0; frame < k_frames; ++frame) writer.write(texture.Get(), frame);
      writer.finalize();
      if (writer.artifact_bytes() == 0 || writer.average_bitrate_bps() == 0 ||
          writer.peak_bitrate_bps() == 0) return 4;
    }

    winrt::check_hresult(MFStartup(MF_VERSION, MFSTARTUP_FULL));
    Microsoft::WRL::ComPtr<IMFSourceReader> reader;
    winrt::check_hresult(
        MFCreateSourceReaderFromURL(output.c_str(), nullptr, reader.ReleaseAndGetAddressOf()));
    Microsoft::WRL::ComPtr<IMFMediaType> decode_type;
    winrt::check_hresult(MFCreateMediaType(decode_type.ReleaseAndGetAddressOf()));
    winrt::check_hresult(decode_type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video));
    winrt::check_hresult(decode_type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32));
    winrt::check_hresult(reader->SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr,
                                                    decode_type.Get()));
    std::uint32_t decoded = 0;
    for (;;) {
      DWORD flags = 0;
      Microsoft::WRL::ComPtr<IMFSample> sample;
      winrt::check_hresult(reader->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, nullptr,
                                              &flags, nullptr, sample.ReleaseAndGetAddressOf()));
      if (flags & MF_SOURCE_READERF_ENDOFSTREAM) break;
      if (sample) ++decoded;
    }
    reader.Reset();
    MFShutdown();
    std::filesystem::remove(output, ignored);
    return decoded == k_frames ? 0 : 2;
  } catch (...) {
    std::filesystem::remove(output, ignored);
    return 1;
  }
}
