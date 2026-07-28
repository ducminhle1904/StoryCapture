#pragma once

#include <windows.h>

#include <cstdint>
#include <string>

#include <d3d11.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

namespace storycapture::wgc {

[[nodiscard]] std::wstring require_hardware_h264_encoder();

class NativeMp4Writer final {
 public:
  NativeMp4Writer(ID3D11Device* device, std::wstring output_path, std::uint32_t width,
                  std::uint32_t height);
  ~NativeMp4Writer();

  NativeMp4Writer(const NativeMp4Writer&) = delete;
  NativeMp4Writer& operator=(const NativeMp4Writer&) = delete;

  void write(ID3D11Texture2D* texture, std::uint64_t frame_index);
  void finalize();

  [[nodiscard]] const std::wstring& encoder_id() const noexcept { return encoder_id_; }
  [[nodiscard]] const std::wstring& output_path() const noexcept { return output_path_; }

 private:
  std::wstring output_path_;
  std::wstring temporary_path_;
  std::wstring encoder_id_;
  std::uint32_t width_{};
  std::uint32_t height_{};
  DWORD stream_index_{};
  bool mf_started_{};
  bool finalized_{};
  Microsoft::WRL::ComPtr<ID3D11Device> device_;
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
  Microsoft::WRL::ComPtr<IMFDXGIDeviceManager> device_manager_;
  Microsoft::WRL::ComPtr<IMFSinkWriter> writer_;
};

}  // namespace storycapture::wgc
