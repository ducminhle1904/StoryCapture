#pragma once

#include <windows.h>

#include <iostream>
#include <initializer_list>
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

inline void require_exact_keys(const JsonObject& object,
                               std::initializer_list<std::wstring_view> keys) {
  if (object.Size() != keys.size()) {
    throw ProtocolError("contract_mismatch", "protocol object contains missing or surplus fields");
  }
  for (const auto key : keys) {
    if (!object.HasKey(key)) {
      throw ProtocolError("contract_mismatch", "protocol object contains missing or surplus fields");
    }
  }
}

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

inline bool required_bool(const JsonObject& object, std::wstring_view key) {
  if (!object.HasKey(key) || object.GetNamedValue(key).ValueType() !=
                                 winrt::Windows::Data::Json::JsonValueType::Boolean) {
    throw ProtocolError("contract_mismatch", "required boolean is missing");
  }
  return object.GetNamedBoolean(key);
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

inline CaptureOptions parse_native_options(const JsonObject& command) {
  CaptureOptions result;
  result.native_mp4 = true;
  result.session_id = required_string(command, L"session_id");
  result.output_path = required_string(command, L"output_path");
  const auto target = command.GetNamedObject(L"target");
  const auto target_kind = required_string(target, L"kind");
  if (target_kind == L"window") {
    require_exact_keys(target,
                       {L"kind", L"hwnd", L"process_id", L"executable_path", L"class_name"});
  } else if (target_kind == L"display") {
    require_exact_keys(target, {L"kind", L"device_path"});
  } else {
    throw ProtocolError("target_missing", "unsupported capture target kind");
  }
  result.target = parse_target(target);
  result.cursor_policy = required_string(command, L"cursor_policy") == L"exclude"
                             ? CursorPolicy::exclude
                             : CursorPolicy::include;
  if (required_string(command, L"dynamic_size_policy") != L"fail") {
    throw ProtocolError("contract_mismatch", "Strict dynamic-size policy must fail closed");
  }
  result.requested_width = required_uint32(command, L"requested_width");
  result.requested_height = required_uint32(command, L"requested_height");
  const auto fps = command.GetNamedObject(L"requested_fps");
  if (fps.GetNamedNumber(L"numerator", 0) != 60 ||
      fps.GetNamedNumber(L"denominator", 0) != 1) {
    throw ProtocolError("contract_mismatch", "native MP4 capture requires exact CFR 60/1");
  }
  return result;
}

inline CaptureOptions parse_v4_options(const JsonObject& command) {
  CaptureOptions result;
  result.native_mp4 = true;
  result.session_id = required_string(command, L"session_id");
  result.output_path = required_string(command, L"output_path");
  result.target = parse_target(command.GetNamedObject(L"target"));
  result.requested_width = 1'920;
  result.requested_height = 1'080;
  result.v4_mode = true;
  result.cursor_policy = required_bool(command, L"include_cursor") ? CursorPolicy::include
                                                                    : CursorPolicy::exclude;
  const auto identity = command.GetNamedObject(L"target_identity");
  require_exact_keys(identity, {L"kind", L"stable_id", L"process_id", L"initial_title"});
  const auto identity_kind = required_string(identity, L"kind");
  if (identity_kind != L"window" && identity_kind != L"author_preview") {
    throw ProtocolError("contract_mismatch", "unsupported V4 target identity kind");
  }
  result.target_stable_id = required_string(identity, L"stable_id");
  if (required_uint32(identity, L"process_id") != result.target.process_id) {
    throw ProtocolError("target_changed", "V4 target process identity does not match");
  }
  if (identity.HasKey(L"initial_title") &&
      identity.GetNamedValue(L"initial_title").ValueType() !=
          winrt::Windows::Data::Json::JsonValueType::Null) {
    result.target_initial_title = identity.GetNamedString(L"initial_title").c_str();
  }
  const auto envelope = command.GetNamedObject(L"encoder_envelope");
  require_exact_keys(envelope, {L"source", L"encoder_id", L"minimum_bitrate_bps",
                                L"target_bitrate_bps", L"maximum_bitrate_bps",
                                L"safety_headroom_ratio"});
  const auto envelope_source = required_string(envelope, L"source");
  if (envelope_source != L"built_in_profile") {
    throw ProtocolError("contract_mismatch", "invalid V4 encoder envelope source");
  }
  result.encoder_envelope_source = envelope_source;
  result.encoder_envelope_id = required_string(envelope, L"encoder_id");
  result.minimum_bitrate_bps = required_uint32(envelope, L"minimum_bitrate_bps");
  result.target_bitrate_bps = required_uint32(envelope, L"target_bitrate_bps");
  result.maximum_bitrate_bps = required_uint32(envelope, L"maximum_bitrate_bps");
  result.safety_headroom_ratio = envelope.GetNamedNumber(L"safety_headroom_ratio", 0);
  if (result.minimum_bitrate_bps > result.target_bitrate_bps ||
      result.target_bitrate_bps > result.maximum_bitrate_bps ||
      result.safety_headroom_ratio <= 0 || result.safety_headroom_ratio >= 1) {
    throw ProtocolError("contract_mismatch", "invalid V4 encoder envelope");
  }
  const auto audio_roles = command.GetNamedArray(L"requested_audio_roles");
  for (const auto& value : audio_roles) {
    const auto role = value.GetString();
    if (role == L"microphone") {
      if (result.microphone_audio) throw ProtocolError("contract_mismatch", "duplicate audio role");
      result.microphone_audio = true;
    } else if (role == L"system") {
      if (result.system_audio) throw ProtocolError("contract_mismatch", "duplicate audio role");
      result.system_audio = true;
    } else {
      throw ProtocolError("contract_mismatch", "unsupported V4 audio role");
    }
  }
  return result;
}

inline JsonObject parse_command(std::wstring_view line, std::uint32_t protocol_version = 2) {
  const auto object = JsonObject::Parse(line);
  if (object.GetNamedNumber(L"version", 0) != protocol_version) {
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
  explicit EventWriter(std::uint32_t protocol_version = 2) : protocol_version_(protocol_version) {}

  void emit(JsonObject object) {
    object.SetNamedValue(L"version", JsonValue::CreateNumberValue(protocol_version_));
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
  std::uint32_t protocol_version_;
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
