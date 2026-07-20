#include "frame_ring.hpp"

#include <algorithm>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string_view>

#include <winrt/base.h>

#include "protocol.hpp"

namespace storycapture::wgc {
namespace {

std::wstring safe_name(std::wstring_view input) {
  std::wstring output;
  output.reserve(std::min<std::size_t>(input.size(), 64));
  for (const auto character : input) {
    if (output.size() == 64) break;
    const bool valid = (character >= L'a' && character <= L'z') ||
                       (character >= L'A' && character <= L'Z') ||
                       (character >= L'0' && character <= L'9') || character == L'-';
    output.push_back(valid ? character : L'_');
  }
  if (output.empty()) throw ProtocolError("contract_mismatch", "empty native ring name");
  return output;
}

void check_size(std::uint64_t size) {
  if (size > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
    throw ProtocolError("backend_capability_mismatch", "native frame ring is too large");
  }
}

}  // namespace

NativeFrameRing::NativeFrameRing(ID3D11Device* device, std::wstring session_id,
                                 std::wstring ownership_token, std::uint32_t width,
                                 std::uint32_t height)
    : width_(width), height_(height), stride_(width * 4), slot_bytes_(stride_ * height) {
  if (!device || width == 0 || height == 0) {
    throw ProtocolError("contract_mismatch", "native ring requires a device and physical size");
  }
  const auto identity = safe_name(session_id) + L"-" + safe_name(ownership_token);
  mapping_name_ = L"Local\\StoryCaptureWgcRing-" + identity;
  frame_event_name_ = L"Local\\StoryCaptureWgcFrame-" + identity;

  const auto metadata_bytes = sizeof(NativeRingHeader) + sizeof(NativeRingSlot) * k_ring_capacity;
  const auto total_bytes = static_cast<std::uint64_t>(metadata_bytes) + slot_bytes_ * k_ring_capacity;
  check_size(total_bytes);
  mapping_ = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
                                static_cast<DWORD>(total_bytes >> 32),
                                static_cast<DWORD>(total_bytes & 0xffffffff), mapping_name_.c_str());
  if (!mapping_ || GetLastError() == ERROR_ALREADY_EXISTS) {
    if (mapping_) CloseHandle(mapping_);
    mapping_ = nullptr;
    throw ProtocolError("contract_mismatch", "native frame-ring mapping already exists");
  }
  view_ = static_cast<std::byte*>(MapViewOfFile(mapping_, FILE_MAP_ALL_ACCESS, 0, 0,
                                                static_cast<SIZE_T>(total_bytes)));
  if (!view_) throw winrt::hresult_error(HRESULT_FROM_WIN32(GetLastError()));
  std::memset(view_, 0, static_cast<std::size_t>(metadata_bytes));
  header_ = reinterpret_cast<NativeRingHeader*>(view_);
  slots_ = reinterpret_cast<NativeRingSlot*>(view_ + sizeof(NativeRingHeader));
  header_->magic = k_ring_magic;
  header_->version = k_protocol_version;
  header_->capacity = k_ring_capacity;
  header_->width = width_;
  header_->height = height_;
  header_->stride = stride_;
  header_->slot_bytes = slot_bytes_;
  for (std::uint32_t index = 0; index < k_ring_capacity; ++index) {
    slots_[index].slot_index = index;
    slots_[index].pixel_offset = metadata_bytes + slot_bytes_ * index;
  }
  frame_event_ = CreateEventW(nullptr, FALSE, FALSE, frame_event_name_.c_str());
  if (!frame_event_ || GetLastError() == ERROR_ALREADY_EXISTS) {
    throw ProtocolError("contract_mismatch", "native frame event already exists");
  }

  device->GetImmediateContext(context_.ReleaseAndGetAddressOf());
  D3D11_TEXTURE2D_DESC description{};
  description.Width = width_;
  description.Height = height_;
  description.MipLevels = 1;
  description.ArraySize = 1;
  description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  description.SampleDesc.Count = 1;
  description.Usage = D3D11_USAGE_STAGING;
  description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  winrt::check_hresult(device->CreateTexture2D(&description, nullptr,
                                               staging_texture_.ReleaseAndGetAddressOf()));
}

NativeFrameRing::~NativeFrameRing() {
  if (view_) UnmapViewOfFile(view_);
  if (frame_event_) CloseHandle(frame_event_);
  if (mapping_) CloseHandle(mapping_);
}

CommittedFrame NativeFrameRing::commit(ID3D11Texture2D* source, std::uint64_t source_frame_index,
                                       std::int64_t native_pts_us, std::int64_t duration_us) {
  if (header_->terminal_failure != 0) {
    throw ProtocolError("frame_ring_overflow", "native frame ring is terminally failed");
  }
  NativeRingSlot* destination = nullptr;
  for (std::uint32_t index = 0; index < k_ring_capacity; ++index) {
    auto& candidate = slots_[(delivery_sequence_ + index) % k_ring_capacity];
    if (InterlockedCompareExchange(&candidate.state, 2, 0) == 0) {
      destination = &candidate;
      break;
    }
  }
  if (!destination) {
    fail();
    throw ProtocolError("frame_ring_overflow", "native eight-slot frame ring is full");
  }

  try {
    context_->CopyResource(staging_texture_.Get(), source);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    winrt::check_hresult(context_->Map(staging_texture_.Get(), 0, D3D11_MAP_READ, 0, &mapped));
    auto* output = reinterpret_cast<std::uint8_t*>(view_ + destination->pixel_offset);
    const auto* input = static_cast<const std::uint8_t*>(mapped.pData);
    for (std::uint32_t row = 0; row < height_; ++row) {
      std::memcpy(output + static_cast<std::size_t>(row) * stride_,
                  input + static_cast<std::size_t>(row) * mapped.RowPitch, stride_);
    }
    context_->Unmap(staging_texture_.Get(), 0);

    const auto sequence = delivery_sequence_ + 1;
    destination->delivery_sequence = sequence;
    destination->source_frame_index = source_frame_index;
    destination->native_pts_us = native_pts_us;
    destination->duration_us = duration_us;
    destination->width = width_;
    destination->height = height_;
    destination->stride = stride_;
    MemoryBarrier();
    InterlockedExchange(&destination->state, 1);
    delivery_sequence_ = sequence;
    SetEvent(frame_event_);
    return {
        .delivery_sequence = sequence,
        .source_frame_index = source_frame_index,
        .native_pts_us = native_pts_us,
        .duration_us = duration_us,
        .slot_index = destination->slot_index,
        .width = width_,
        .height = height_,
        .stride = stride_,
    };
  } catch (...) {
    InterlockedExchange(&destination->state, 0);
    throw;
  }
}

void NativeFrameRing::fail() noexcept {
  if (header_) InterlockedExchange(&header_->terminal_failure, 1);
  if (frame_event_) SetEvent(frame_event_);
}

}  // namespace storycapture::wgc
