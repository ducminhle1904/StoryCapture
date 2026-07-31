#include "native_mp4_writer.hpp"

#include <filesystem>
#include <format>
#include <algorithm>
#include <map>
#include <vector>

#include <codecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mftransform.h>
#include <winrt/base.h>

#include "protocol.hpp"

namespace storycapture::wgc {
namespace {

constexpr LONGLONG frame_time_100ns(std::uint64_t frame_index) {
  return static_cast<LONGLONG>((frame_index * 10'000'000) / 60);
}

std::wstring select_hardware_h264_encoder() {
  MFT_REGISTER_TYPE_INFO output_type{MFMediaType_Video, MFVideoFormat_H264};
  IMFActivate** activates = nullptr;
  UINT32 count = 0;
  const auto result = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER,
                                MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                                nullptr, &output_type, &activates, &count);
  if (FAILED(result) || count == 0) {
    if (activates) CoTaskMemFree(activates);
    throw ProtocolError("encoder_unavailable", "no Media Foundation hardware H.264 encoder");
  }
  UINT32 name_bytes = 0;
  wchar_t* name = nullptr;
  std::wstring encoder = L"media-foundation-hardware-h264";
  if (SUCCEEDED(activates[0]->GetAllocatedString(MFT_FRIENDLY_NAME_Attribute, &name, &name_bytes)) &&
      name) {
    encoder.assign(name);
    CoTaskMemFree(name);
  }
  for (UINT32 index = 0; index < count; ++index) activates[index]->Release();
  CoTaskMemFree(activates);
  return encoder;
}

Microsoft::WRL::ComPtr<IMFMediaType> media_type() {
  Microsoft::WRL::ComPtr<IMFMediaType> value;
  winrt::check_hresult(MFCreateMediaType(value.ReleaseAndGetAddressOf()));
  return value;
}

struct BitrateMeasurement {
  std::uint32_t average_bps{};
  std::uint32_t peak_bps{};
};

BitrateMeasurement measure_encoded_bitrate(const std::wstring& path) {
  Microsoft::WRL::ComPtr<IMFSourceReader> reader;
  winrt::check_hresult(
      MFCreateSourceReaderFromURL(path.c_str(), nullptr, reader.ReleaseAndGetAddressOf()));
  std::uint64_t total_bytes = 0;
  LONGLONG duration_100ns = 0;
  std::map<LONGLONG, std::uint64_t> bytes_by_second;
  for (;;) {
    DWORD flags = 0;
    LONGLONG timestamp = 0;
    Microsoft::WRL::ComPtr<IMFSample> sample;
    winrt::check_hresult(reader->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, nullptr,
                                            &flags, &timestamp, sample.ReleaseAndGetAddressOf()));
    if (flags & MF_SOURCE_READERF_ENDOFSTREAM) break;
    if (!sample) continue;
    DWORD bytes = 0;
    winrt::check_hresult(sample->GetTotalLength(&bytes));
    LONGLONG sample_duration = 0;
    if (FAILED(sample->GetSampleDuration(&sample_duration)) || sample_duration <= 0) {
      sample_duration = frame_time_100ns(1);
    }
    total_bytes += bytes;
    duration_100ns = std::max(duration_100ns, timestamp + sample_duration);
    bytes_by_second[timestamp / 10'000'000] += bytes;
  }
  if (total_bytes == 0 || duration_100ns <= 0) {
    throw ProtocolError("artifact_probe_failed", "finalized MP4 contains no encoded video samples");
  }
  const auto average = std::min<std::uint64_t>(
      UINT32_MAX, (total_bytes * 8ULL * 10'000'000ULL) / static_cast<std::uint64_t>(duration_100ns));
  std::uint64_t peak = 0;
  for (const auto& entry : bytes_by_second) peak = std::max(peak, entry.second * 8ULL);
  return {static_cast<std::uint32_t>(average),
          static_cast<std::uint32_t>(std::min<std::uint64_t>(UINT32_MAX, peak))};
}

void verify_hardware_encoder_selected(IMFSinkWriter* writer, DWORD stream_index) {
  Microsoft::WRL::ComPtr<IMFSinkWriterEx> extended;
  winrt::check_hresult(writer->QueryInterface(IID_PPV_ARGS(extended.ReleaseAndGetAddressOf())));
  for (DWORD index = 0;; ++index) {
    GUID category{};
    Microsoft::WRL::ComPtr<IMFTransform> transform;
    const auto result = extended->GetTransformForStream(
        stream_index, index, &category, transform.ReleaseAndGetAddressOf());
    if (result == MF_E_INVALIDINDEX) break;
    winrt::check_hresult(result);
    if (!IsEqualGUID(category, MFT_CATEGORY_VIDEO_ENCODER)) continue;
    Microsoft::WRL::ComPtr<IMFAttributes> attributes;
    winrt::check_hresult(transform->GetAttributes(attributes.ReleaseAndGetAddressOf()));
    UINT32 hardware_url_length = 0;
    wchar_t* hardware_url = nullptr;
    const auto hardware_result = attributes->GetAllocatedString(
        MFT_ENUM_HARDWARE_URL_Attribute, &hardware_url, &hardware_url_length);
    if (SUCCEEDED(hardware_result) && hardware_url && hardware_url_length > 0) {
      CoTaskMemFree(hardware_url);
      return;
    }
    if (hardware_url) CoTaskMemFree(hardware_url);
    throw ProtocolError("encoder_unavailable",
                        "Media Foundation selected a non-hardware H.264 encoder");
  }
  throw ProtocolError("encoder_unavailable", "Media Foundation exposed no H.264 encoder transform");
}

}  // namespace

std::wstring require_hardware_h264_encoder() { return select_hardware_h264_encoder(); }

NativeMp4Writer::NativeMp4Writer(ID3D11Device* device, std::wstring output_path,
                                 std::uint32_t width, std::uint32_t height,
                                 std::uint32_t target_bitrate_bps, bool measure_bitrate)
    : output_path_(std::move(output_path)),
      temporary_path_(output_path_ + L".partial"),
      width_(width),
      height_(height),
      target_bitrate_bps_(target_bitrate_bps),
      measure_bitrate_(measure_bitrate),
      device_(device) {
  if (output_path_.empty() || width_ == 0 || height_ == 0 || width_ % 2 != 0 || height_ % 2 != 0 ||
      target_bitrate_bps_ == 0) {
    throw ProtocolError("contract_mismatch", "invalid native MP4 output contract");
  }
  std::filesystem::create_directories(std::filesystem::path(output_path_).parent_path());
  std::filesystem::remove(temporary_path_);
  winrt::check_hresult(MFStartup(MF_VERSION, MFSTARTUP_FULL));
  mf_started_ = true;
  try {
    encoder_id_ = require_hardware_h264_encoder();
    device_->GetImmediateContext(context_.ReleaseAndGetAddressOf());
    UINT reset_token = 0;
    winrt::check_hresult(
        MFCreateDXGIDeviceManager(&reset_token, device_manager_.ReleaseAndGetAddressOf()));
    winrt::check_hresult(device_manager_->ResetDevice(device_.Get(), reset_token));

    Microsoft::WRL::ComPtr<IMFAttributes> attributes;
    winrt::check_hresult(MFCreateAttributes(attributes.ReleaseAndGetAddressOf(), 4));
    winrt::check_hresult(attributes->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE));
    winrt::check_hresult(attributes->SetUINT32(MF_LOW_LATENCY, TRUE));
    winrt::check_hresult(attributes->SetUnknown(MF_SINK_WRITER_D3D_MANAGER, device_manager_.Get()));
    winrt::check_hresult(MFCreateSinkWriterFromURL(temporary_path_.c_str(), nullptr, attributes.Get(),
                                                   writer_.ReleaseAndGetAddressOf()));

    auto output = media_type();
    winrt::check_hresult(output->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video));
    winrt::check_hresult(output->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264));
    winrt::check_hresult(output->SetUINT32(MF_MT_AVG_BITRATE, target_bitrate_bps_));
    winrt::check_hresult(output->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive));
    winrt::check_hresult(MFSetAttributeSize(output.Get(), MF_MT_FRAME_SIZE, width_, height_));
    winrt::check_hresult(MFSetAttributeRatio(output.Get(), MF_MT_FRAME_RATE, 60, 1));
    winrt::check_hresult(MFSetAttributeRatio(output.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1));
    winrt::check_hresult(writer_->AddStream(output.Get(), &stream_index_));

    auto input = media_type();
    winrt::check_hresult(input->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video));
    winrt::check_hresult(input->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_ARGB32));
    winrt::check_hresult(input->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive));
    winrt::check_hresult(MFSetAttributeSize(input.Get(), MF_MT_FRAME_SIZE, width_, height_));
    winrt::check_hresult(MFSetAttributeRatio(input.Get(), MF_MT_FRAME_RATE, 60, 1));
    winrt::check_hresult(MFSetAttributeRatio(input.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1));
    winrt::check_hresult(writer_->SetInputMediaType(stream_index_, input.Get(), nullptr));
    winrt::check_hresult(writer_->BeginWriting());
    verify_hardware_encoder_selected(writer_.Get(), stream_index_);
  } catch (...) {
    writer_.Reset();
    device_manager_.Reset();
    MFShutdown();
    mf_started_ = false;
    std::error_code ignored;
    std::filesystem::remove(temporary_path_, ignored);
    throw;
  }
}

NativeMp4Writer::~NativeMp4Writer() {
  writer_.Reset();
  device_manager_.Reset();
  if (mf_started_) MFShutdown();
  if (!finalized_) {
    std::error_code ignored;
    std::filesystem::remove(temporary_path_, ignored);
  }
}

void NativeMp4Writer::write(ID3D11Texture2D* texture, std::uint64_t frame_index) {
  D3D11_TEXTURE2D_DESC source{};
  texture->GetDesc(&source);
  if (source.Width != width_ || source.Height != height_ || source.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
    throw ProtocolError("target_changed", "WGC surface no longer matches the MP4 contract");
  }
  D3D11_TEXTURE2D_DESC copy = source;
  copy.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
  copy.CPUAccessFlags = 0;
  copy.MiscFlags = 0;
  copy.Usage = D3D11_USAGE_DEFAULT;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> retained;
  winrt::check_hresult(device_->CreateTexture2D(&copy, nullptr, retained.ReleaseAndGetAddressOf()));
  context_->CopyResource(retained.Get(), texture);

  Microsoft::WRL::ComPtr<IMFMediaBuffer> buffer;
  winrt::check_hresult(MFCreateDXGISurfaceBuffer(__uuidof(ID3D11Texture2D), retained.Get(), 0,
                                                 FALSE, buffer.ReleaseAndGetAddressOf()));
  Microsoft::WRL::ComPtr<IMFSample> sample;
  winrt::check_hresult(MFCreateSample(sample.ReleaseAndGetAddressOf()));
  winrt::check_hresult(sample->AddBuffer(buffer.Get()));
  const auto sample_time = frame_time_100ns(frame_index);
  const auto sample_end = frame_time_100ns(frame_index + 1);
  winrt::check_hresult(sample->SetSampleTime(sample_time));
  winrt::check_hresult(sample->SetSampleDuration(sample_end - sample_time));
  const auto result = writer_->WriteSample(stream_index_, sample.Get());
  if (result == MF_E_NOTACCEPTING) {
    throw ProtocolError("encoder_backpressure", "hardware H.264 encoder reported backpressure");
  }
  if (FAILED(result)) {
    throw ProtocolError("encoder_rejected_frame", "hardware H.264 encoder rejected frame");
  }
}

void NativeMp4Writer::finalize() {
  if (finalized_) return;
  const auto result = writer_->Finalize();
  writer_.Reset();
  if (FAILED(result)) throw ProtocolError("artifact_finalize_failed", "Media Foundation MP4 finalization failed");
  if (!MoveFileExW(temporary_path_.c_str(), output_path_.c_str(), MOVEFILE_WRITE_THROUGH)) {
    throw ProtocolError("artifact_finalize_failed", "finalized MP4 could not be promoted atomically");
  }
  std::error_code error;
  artifact_bytes_ = std::filesystem::file_size(output_path_, error);
  if (error || artifact_bytes_ == 0) {
    throw ProtocolError("artifact_finalize_failed", "finalized MP4 is empty or unreadable");
  }
  if (measure_bitrate_) {
    const auto bitrate = measure_encoded_bitrate(output_path_);
    average_bitrate_bps_ = bitrate.average_bps;
    peak_bitrate_bps_ = bitrate.peak_bps;
  }
  finalized_ = true;
}

}  // namespace storycapture::wgc
