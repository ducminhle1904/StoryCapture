#pragma once

#include <windows.h>

#include <iostream>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>

#include <winrt/Windows.Data.Json.h>

#include "capture_types.hpp"

namespace storycapture::wgc {

using JsonObject = winrt::Windows::Data::Json::JsonObject;
using JsonValue = winrt::Windows::Data::Json::JsonValue;

class ProtocolError final : public std::runtime_error {
 public:
  ProtocolError(std::string failure_code, std::string message)
      : std::runtime_error(std::move(message)), failure_code_(std::move(failure_code)) {}

  [[nodiscard]] const std::string& failure_code() const noexcept { return failure_code_; }

 private:
  std::string failure_code_;
};

inline std::wstring required_string(const JsonObject& object, std::wstring_view key) {
  if (!object.HasKey(key)) throw ProtocolError("contract_mismatch", "required string is missing");
  const auto value = object.GetNamedString(key, L"");
  if (value.empty()) throw ProtocolError("contract_mismatch", "required string is empty");
  return value.c_str();
}

inline std::uint32_t required_uint32(const JsonObject& object, std::wstring_view key) {
  if (!object.HasKey(key)) throw ProtocolError("contract_mismatch", "required number is missing");
  const auto value = object.GetNamedNumber(key, 0);
  if (value <= 0 || value > static_cast<double>(UINT32_MAX)) {
    throw ProtocolError("contract_mismatch", "required number is outside uint32 range");
  }
  return static_cast<std::uint32_t>(value);
}

inline CaptureTarget parse_target(const JsonObject& object) {
  CaptureTarget result;
  const auto kind = required_string(object, L"kind");
  if (kind == L"display") {
    result.kind = TargetKind::display;
    result.device_path = required_string(object, L"device_path");
    return result;
  }
  if (kind != L"window") throw ProtocolError("target_missing", "unsupported capture target kind");
  result.kind = TargetKind::window;
  const auto hwnd_text = required_string(object, L"hwnd");
  std::size_t consumed = 0;
  result.hwnd = std::stoull(hwnd_text, &consumed, 16);
  if (consumed != hwnd_text.size() || result.hwnd == 0) {
    throw ProtocolError("target_missing", "invalid window handle");
  }
  result.process_id = required_uint32(object, L"process_id");
  result.executable_path = required_string(object, L"executable_path");
  result.class_name = required_string(object, L"class_name");
  return result;
}

inline CaptureOptions parse_options(const JsonObject& command) {
  if (!command.HasKey(L"options")) {
    throw ProtocolError("contract_mismatch", "capture options are missing");
  }
  const auto object = command.GetNamedObject(L"options");
  CaptureOptions result;
  result.ownership_token = required_string(object, L"ownership_token");
  result.target = parse_target(object.GetNamedObject(L"target"));
  result.cursor_policy = required_string(object, L"cursor_policy") == L"exclude"
                             ? CursorPolicy::exclude
                             : CursorPolicy::include;
  if (required_string(object, L"dynamic_size_policy") != L"fail") {
    throw ProtocolError("contract_mismatch", "Strict dynamic-size policy must fail closed");
  }
  result.requested_width = required_uint32(object, L"requested_width");
  result.requested_height = required_uint32(object, L"requested_height");
  if (object.HasKey(L"audio_roles")) {
    for (const auto& role : object.GetNamedArray(L"audio_roles")) {
      const auto name = role.GetString();
      result.microphone_audio = result.microphone_audio || name == L"microphone";
      result.system_audio = result.system_audio || name == L"system";
    }
  }
  return result;
}

inline JsonObject parse_command(std::wstring_view line) {
  const auto object = JsonObject::Parse(line);
  if (object.GetNamedNumber(L"version", 0) != 2) {
    throw ProtocolError("contract_mismatch", "unsupported helper protocol version");
  }
  required_string(object, L"type");
  return object;
}

inline void set_string(JsonObject& object, std::wstring_view key, std::wstring_view value) {
  object.SetNamedValue(key, JsonValue::CreateStringValue(value));
}

inline void set_number(JsonObject& object, std::wstring_view key, double value) {
  object.SetNamedValue(key, JsonValue::CreateNumberValue(value));
}

inline void set_bool(JsonObject& object, std::wstring_view key, bool value) {
  object.SetNamedValue(key, JsonValue::CreateBooleanValue(value));
}

class EventWriter final {
 public:
  void emit(JsonObject object) {
    object.SetNamedValue(L"version", JsonValue::CreateNumberValue(2));
    std::scoped_lock lock(mutex_);
    std::wcout << object.Stringify().c_str() << L'\n' << std::flush;
  }

  void failure(std::wstring_view session_id, std::wstring_view code, std::wstring_view message) {
    JsonObject event;
    set_string(event, L"type", L"failure");
    if (session_id.empty()) {
      event.SetNamedValue(L"session_id", JsonValue::CreateNullValue());
    } else {
      set_string(event, L"session_id", session_id);
    }
    set_string(event, L"failure_code", code);
    set_string(event, L"message", message);
    emit(std::move(event));
  }

 private:
  std::mutex mutex_;
};

inline std::wstring widen(std::string_view value) {
  if (value.empty()) return {};
  const auto length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                          static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) return L"native helper error";
  std::wstring result(static_cast<std::size_t>(length), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
                      result.data(), length);
  return result;
}

}  // namespace storycapture::wgc
