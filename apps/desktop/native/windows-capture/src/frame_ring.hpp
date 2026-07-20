#pragma once

#include <windows.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>

#include <d3d11.h>
#include <wrl/client.h>

#include "capture_types.hpp"

namespace storycapture::wgc {

inline constexpr std::uint32_t k_protocol_version = 2;
inline constexpr std::uint32_t k_ring_capacity = 8;
inline constexpr std::uint32_t k_ring_magic = 0x32474353;  // SCG2

struct alignas(64) NativeRingHeader {
  std::uint32_t magic{};
  std::uint32_t version{};
  std::uint32_t capacity{};
  std::uint32_t width{};
  std::uint32_t height{};
  std::uint32_t stride{};
  std::uint64_t slot_bytes{};
  volatile LONG terminal_failure{};
  std::uint32_t reserved[7]{};
};

struct alignas(64) NativeRingSlot {
  volatile LONG state{};  // 0 free, 2 producer-owned, 1 committed, 3 consumer-owned
  std::uint32_t slot_index{};
  std::uint64_t delivery_sequence{};
  std::uint64_t source_frame_index{};
  std::int64_t native_pts_us{};
  std::int64_t duration_us{};
  std::uint32_t width{};
  std::uint32_t height{};
  std::uint32_t stride{};
  std::uint32_t reserved{};
  std::uint64_t pixel_offset{};
};

class NativeFrameRing final {
 public:
  NativeFrameRing(ID3D11Device* device, std::wstring session_id, std::wstring ownership_token,
                  std::uint32_t width, std::uint32_t height);
  ~NativeFrameRing();

  NativeFrameRing(const NativeFrameRing&) = delete;
  NativeFrameRing& operator=(const NativeFrameRing&) = delete;

  [[nodiscard]] const std::wstring& mapping_name() const noexcept { return mapping_name_; }
  [[nodiscard]] const std::wstring& frame_event_name() const noexcept { return frame_event_name_; }
  [[nodiscard]] std::uint32_t width() const noexcept { return width_; }
  [[nodiscard]] std::uint32_t height() const noexcept { return height_; }
  [[nodiscard]] std::uint32_t stride() const noexcept { return stride_; }

  CommittedFrame commit(ID3D11Texture2D* source, std::uint64_t source_frame_index,
                        std::int64_t native_pts_us, std::int64_t duration_us);
  void fail() noexcept;

 private:
  std::wstring mapping_name_;
  std::wstring frame_event_name_;
  std::uint32_t width_{};
  std::uint32_t height_{};
  std::uint32_t stride_{};
  std::uint64_t slot_bytes_{};
  std::uint64_t delivery_sequence_{};
  HANDLE mapping_{};
  HANDLE frame_event_{};
  std::byte* view_{};
  NativeRingHeader* header_{};
  NativeRingSlot* slots_{};
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> staging_texture_;
};

}  // namespace storycapture::wgc
