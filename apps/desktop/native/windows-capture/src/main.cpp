#include <windows.h>

#include <fcntl.h>
#include <io.h>

#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <memory>
#include <numeric>
#include <string>
#include <thread>
#include <filesystem>

#include <mfapi.h>
#include <winrt/base.h>

#include "capture_session.hpp"
#include "protocol.hpp"

namespace storycapture::wgc {
namespace {

void emit_hello(EventWriter& writer) {
  JsonObject event;
  set_string(event, L"type", L"hello");
  set_string(event, L"backend_id", L"windows-graphics-capture");
  set_string(event, L"backend_version", L"1.0.0");
  set_number(event, L"process_id", GetCurrentProcessId());
  writer.emit(std::move(event));
}

void emit_probe_result(EventWriter& writer, const ProbeObservation& result, std::uint32_t duration_ms,
                       std::uint32_t requested_width, std::uint32_t requested_height) {
  std::int64_t measured_millihertz = 0;
  if (result.source_presentations > 1 && result.last_pts_us > result.first_pts_us) {
    measured_millihertz = static_cast<std::int64_t>(std::llround(
        static_cast<double>((result.source_presentations - 1) * 1'000'000'000ULL) /
        static_cast<double>(result.last_pts_us - result.first_pts_us)));
  }

  JsonObject probe;
  set_string(probe, L"backend_id", L"windows-graphics-capture");
  set_string(probe, L"backend_version", L"1.0.0");
  set_string(probe, L"gpu_identity", result.gpu_identity);
  set_string(probe, L"hardware_fingerprint", result.hardware_fingerprint);
  set_string(probe, L"adapter_luid", result.adapter_luid);
  set_bool(probe, L"permissions_granted", result.permissions_granted);
  set_number(probe, L"source_presentations", static_cast<double>(result.source_presentations));
  set_number(probe, L"probe_duration_ms", duration_ms);
  if (measured_millihertz == 60'000) {
    set_number(probe, L"measured_fps_numerator", 60);
    set_number(probe, L"measured_fps_denominator", 1);
  } else if (measured_millihertz > 0) {
    const auto divisor = std::gcd(measured_millihertz, std::int64_t{1'000});
    set_number(probe, L"measured_fps_numerator", measured_millihertz / divisor);
    set_number(probe, L"measured_fps_denominator", 1'000 / divisor);
  } else {
    probe.SetNamedValue(L"measured_fps_numerator", JsonValue::CreateNullValue());
    probe.SetNamedValue(L"measured_fps_denominator", JsonValue::CreateNullValue());
  }
  set_number(probe, L"sequence_gaps", static_cast<double>(result.sequence_gaps));
  set_number(probe, L"stale_reuses", static_cast<double>(result.stale_reuses));
  set_number(probe, L"physical_width", result.physical_width);
  set_number(probe, L"physical_height", result.physical_height);
  winrt::Windows::Data::Json::JsonArray failure_codes;
  if (measured_millihertz != 60'000 || result.sequence_gaps != 0 || result.stale_reuses != 0) {
    failure_codes.Append(JsonValue::CreateStringValue(L"source_rate_mismatch"));
  }
  if (result.physical_width < requested_width || result.physical_height < requested_height) {
    failure_codes.Append(JsonValue::CreateStringValue(L"backend_capability_mismatch"));
  }
  for (const auto& code : result.failure_codes) {
    failure_codes.Append(JsonValue::CreateStringValue(code));
  }
  probe.SetNamedValue(L"failure_codes", failure_codes);

  JsonObject event;
  set_string(event, L"type", L"probe-result");
  event.SetNamedValue(L"result", probe);
  writer.emit(std::move(event));
}

void emit_ready(EventWriter& writer, const CaptureOptions& options, const NativeFrameRing& ring) {
  JsonObject descriptor;
  set_string(descriptor, L"mapping_name", ring.mapping_name());
  set_string(descriptor, L"frame_event_name", ring.frame_event_name());
  set_string(descriptor, L"ownership_token", options.ownership_token);
  set_number(descriptor, L"capacity", k_ring_capacity);
  set_number(descriptor, L"width", ring.width());
  set_number(descriptor, L"height", ring.height());
  set_number(descriptor, L"stride", ring.stride());
  set_string(descriptor, L"pixel_format", L"bgra");

  JsonObject event;
  set_string(event, L"type", L"ready");
  set_string(event, L"session_id", options.session_id);
  event.SetNamedValue(L"ring", descriptor);
  writer.emit(std::move(event));
}

void emit_clock_anchor(EventWriter& writer, const CaptureOptions& options) {
  LARGE_INTEGER counter{};
  LARGE_INTEGER frequency{};
  QueryPerformanceCounter(&counter);
  QueryPerformanceFrequency(&frequency);
  JsonObject event;
  set_string(event, L"type", L"clock-anchor");
  set_string(event, L"session_id", options.session_id);
  set_number(event, L"qpc_timestamp_us",
             static_cast<double>((counter.QuadPart * 1'000'000) / frequency.QuadPart));
  set_number(event, L"audio_sample_rate", 48'000);
  writer.emit(std::move(event));
}

void emit_lifecycle(EventWriter& writer, std::wstring_view type, std::wstring_view session_id) {
  JsonObject event;
  set_string(event, L"type", type);
  set_string(event, L"session_id", session_id);
  writer.emit(std::move(event));
}

void emit_native_capabilities(EventWriter& writer) {
  winrt::check_hresult(MFStartup(MF_VERSION, MFSTARTUP_FULL));
  std::wstring encoder;
  try {
    encoder = require_hardware_h264_encoder();
  } catch (...) {
    MFShutdown();
    throw;
  }
  MFShutdown();
  JsonObject capabilities;
  set_string(capabilities, L"backend_id", L"windows-graphics-capture");
  set_string(capabilities, L"backend_version", L"1.0.0");
  set_string(capabilities, L"platform", L"win32");
#if defined(_M_ARM64)
  set_string(capabilities, L"arch", L"arm64");
#else
  set_string(capabilities, L"arch", L"x64");
#endif
  winrt::Windows::Data::Json::JsonArray target_classes;
  target_classes.Append(JsonValue::CreateStringValue(L"display"));
  target_classes.Append(JsonValue::CreateStringValue(L"window"));
  capabilities.SetNamedValue(L"target_classes", target_classes);
  set_string(capabilities, L"codec", L"h264");
  set_string(capabilities, L"pixel_format", L"nv12");
  JsonObject fps;
  set_number(fps, L"numerator", 60);
  set_number(fps, L"denominator", 1);
  capabilities.SetNamedValue(L"exact_fps", fps);
  set_bool(capabilities, L"hardware_accelerated", true);
  set_bool(capabilities, L"supports_pause_resume", true);
  set_bool(capabilities, L"keeps_surfaces_native", true);
  set_string(capabilities, L"encoder_id", encoder);
  capabilities.SetNamedValue(L"gpu_identity", JsonValue::CreateNullValue());
  capabilities.SetNamedValue(L"adapter_luid", JsonValue::CreateNullValue());
  JsonObject event;
  set_string(event, L"type", L"capabilities");
  event.SetNamedValue(L"capabilities", capabilities);
  writer.emit(std::move(event));
}

void emit_native_evidence(EventWriter& writer, std::wstring_view session_id,
                          const NativeCaptureEvidence& evidence) {
  JsonObject value;
  set_string(value, L"artifact_path", evidence.artifact_path);
  set_string(value, L"codec", L"h264");
  set_string(value, L"pixel_format", L"nv12");
  set_number(value, L"width", evidence.width);
  set_number(value, L"height", evidence.height);
  JsonObject fps;
  set_number(fps, L"numerator", 60);
  set_number(fps, L"denominator", 1);
  value.SetNamedValue(L"exact_fps", fps);
  set_number(value, L"source_frames", static_cast<double>(evidence.source_frames));
  set_number(value, L"output_frames", static_cast<double>(evidence.output_frames));
  set_number(value, L"held_frames", static_cast<double>(evidence.held_frames));
  set_number(value, L"encoder_dropped_frames",
             static_cast<double>(evidence.encoder_dropped_frames));
  set_number(value, L"backpressure_events", static_cast<double>(evidence.backpressure_events));
  set_number(value, L"unresolved_backpressure_events",
             static_cast<double>(evidence.unresolved_backpressure_events));
  set_number(value, L"pts_gaps", static_cast<double>(evidence.pts_gaps));
  set_number(value, L"pts_duplicates", static_cast<double>(evidence.pts_duplicates));
  set_number(value, L"pts_non_monotonic", static_cast<double>(evidence.pts_non_monotonic));
  set_bool(value, L"initial_surface_received", evidence.initial_surface_received);
  set_number(value, L"started_monotonic_us",
             static_cast<double>(evidence.started_monotonic_us));
  set_number(value, L"ended_monotonic_us", static_cast<double>(evidence.ended_monotonic_us));
  set_number(value, L"finalized_duration_us",
             static_cast<double>(evidence.finalized_duration_us));
  set_string(value, L"encoder_id", evidence.encoder_id);
  set_bool(value, L"hardware_accelerated", true);
  set_bool(value, L"finalized", true);
  value.SetNamedValue(L"failure_codes", winrt::Windows::Data::Json::JsonArray{});
  JsonObject event;
  set_string(event, L"type", L"finalized");
  set_string(event, L"session_id", session_id);
  event.SetNamedValue(L"evidence", value);
  writer.emit(std::move(event));
}

void append_encoder_evidence(JsonObject& value, const CaptureOptions& options,
                             const NativeCaptureEvidence& evidence) {
  set_string(value, L"encoder_id", evidence.encoder_id);
  set_bool(value, L"hardware_accelerated", true);
  set_number(value, L"requested_bitrate_bps", evidence.requested_bitrate_bps);
  set_number(value, L"average_bitrate_bps", evidence.average_bitrate_bps);
  set_number(value, L"peak_bitrate_bps", evidence.peak_bitrate_bps);
  JsonObject envelope;
  set_string(envelope, L"source", options.encoder_envelope_source);
  set_string(envelope, L"encoder_id", evidence.encoder_id);
  set_number(envelope, L"minimum_bitrate_bps", options.minimum_bitrate_bps);
  set_number(envelope, L"target_bitrate_bps", options.target_bitrate_bps);
  set_number(envelope, L"maximum_bitrate_bps", options.maximum_bitrate_bps);
  set_number(envelope, L"safety_headroom_ratio", options.safety_headroom_ratio);
  value.SetNamedValue(L"envelope", envelope);
}

JsonObject v4_encoder_evidence(const CaptureOptions& options,
                               const NativeCaptureEvidence& evidence) {
  JsonObject value;
  append_encoder_evidence(value, options, evidence);
  return value;
}

JsonObject v4_cadence_evidence(const NativeCaptureEvidence& evidence) {
  JsonObject value;
  set_number(value, L"version", 4);
  JsonObject frame_rate;
  set_number(frame_rate, L"numerator", 60);
  set_number(frame_rate, L"denominator", 1);
  value.SetNamedValue(L"frame_rate", frame_rate);
  const auto active_duration_us = evidence.ended_monotonic_us - evidence.started_monotonic_us -
                                  std::accumulate(
                                      evidence.pause_intervals.begin(), evidence.pause_intervals.end(),
                                      std::int64_t{0}, [](auto total, const auto& interval) {
                                        return total + interval.ended_monotonic_us -
                                               interval.started_monotonic_us;
                                      });
  set_number(value, L"active_duration_us", static_cast<double>(active_duration_us));
  set_number(value, L"expected_output_frames",
             static_cast<double>(v4_expected_frames(active_duration_us)));
  set_number(value, L"output_frames", static_cast<double>(evidence.output_frames));
  set_number(value, L"source_updates", static_cast<double>(evidence.source_frames));
  set_number(value, L"held_frames", static_cast<double>(evidence.held_frames));
  set_number(value, L"submitted_frames", static_cast<double>(evidence.frame_ledger.size()));
  set_number(value, L"acknowledged_frames", static_cast<double>(evidence.frame_ledger.size()));
  set_number(value, L"ring_high_water_mark", evidence.ring_high_water_mark);
  winrt::Windows::Data::Json::JsonArray pauses;
  for (const auto& interval : evidence.pause_intervals) {
    JsonObject item;
    set_number(item, L"started_monotonic_us", static_cast<double>(interval.started_monotonic_us));
    set_number(item, L"ended_monotonic_us", static_cast<double>(interval.ended_monotonic_us));
    pauses.Append(item);
  }
  value.SetNamedValue(L"pause_intervals", pauses);
  winrt::Windows::Data::Json::JsonArray ledger;
  for (const auto& entry : evidence.frame_ledger) {
    JsonObject item;
    set_number(item, L"slot", static_cast<double>(entry.slot));
    set_number(item, L"pts_us", static_cast<double>(entry.pts_us));
    set_number(item, L"source_sequence", static_cast<double>(entry.source_sequence));
    set_number(item, L"source_timestamp_us", static_cast<double>(entry.source_timestamp_us));
    if (entry.held_from_slot) {
      set_number(item, L"held_from_slot", static_cast<double>(*entry.held_from_slot));
    } else {
      item.SetNamedValue(L"held_from_slot", JsonValue::CreateNullValue());
    }
    set_number(item, L"submitted_at_us", static_cast<double>(entry.submitted_at_us));
    set_number(item, L"acknowledged_at_us", static_cast<double>(entry.acknowledged_at_us));
    ledger.Append(item);
  }
  value.SetNamedValue(L"ledger", ledger);
  const bool passed = evidence.output_frames == v4_expected_frames(active_duration_us) &&
                      evidence.frame_ledger.size() == evidence.output_frames;
  set_string(value, L"verdict", passed ? L"passed" : L"failed");
  winrt::Windows::Data::Json::JsonArray failures;
  if (!passed) failures.Append(JsonValue::CreateStringValue(L"output_frame_count_mismatch"));
  value.SetNamedValue(L"failure_codes", failures);
  return value;
}

JsonObject v4_audio_evidence(const V4AudioEvidence& evidence) {
  JsonObject value;
  set_string(value, L"role", evidence.role == V4AudioRole::microphone ? L"microphone" : L"system");
  set_bool(value, L"requested", true);
  set_string(value, L"status", L"captured");
  set_string(value, L"codec", evidence.codec);
  set_number(value, L"sample_rate_hz", evidence.sample_rate_hz);
  set_number(value, L"channels", evidence.channels);
  set_number(value, L"started_offset_us", static_cast<double>(evidence.started_offset_us));
  set_number(value, L"duration_us", static_cast<double>(evidence.duration_us));
  set_number(value, L"end_drift_us", static_cast<double>(evidence.end_drift_us));
  set_number(value, L"sync_tolerance_us", static_cast<double>(evidence.sync_tolerance_us));
  set_bool(value, L"pause_mapping_valid", evidence.pause_mapping_valid);
  set_number(value, L"continuity_gaps", static_cast<double>(evidence.continuity_gaps));
  winrt::Windows::Data::Json::JsonArray ledger;
  for (const auto& entry : evidence.ledger) {
    JsonObject item;
    set_number(item, L"sequence", static_cast<double>(entry.sequence));
    set_number(item, L"pts_us", static_cast<double>(entry.pts_us));
    set_number(item, L"duration_us", static_cast<double>(entry.duration_us));
    set_number(item, L"frames", entry.frames);
    ledger.Append(item);
  }
  value.SetNamedValue(L"ledger", ledger);
  value.SetNamedValue(L"failure_codes", winrt::Windows::Data::Json::JsonArray{});
  return value;
}

void emit_v4_capabilities(EventWriter& writer) {
  winrt::check_hresult(MFStartup(MF_VERSION, MFSTARTUP_FULL));
  std::wstring encoder;
  try {
    encoder = require_hardware_h264_encoder();
  } catch (...) {
    MFShutdown();
    throw;
  }
  MFShutdown();
  JsonObject capabilities;
  set_string(capabilities, L"backend_id", L"windows-graphics-capture");
  set_string(capabilities, L"backend_version", L"1.0.0");
  set_string(capabilities, L"platform", L"win32");
#if defined(_M_ARM64)
  set_string(capabilities, L"arch", L"arm64");
#else
  set_string(capabilities, L"arch", L"x64");
#endif
  set_string(capabilities, L"codec", L"h264");
  set_string(capabilities, L"pixel_format", L"nv12");
  JsonObject fps;
  set_number(fps, L"numerator", 60);
  set_number(fps, L"denominator", 1);
  capabilities.SetNamedValue(L"exact_fps", fps);
  set_number(capabilities, L"physical_width", 1'920);
  set_number(capabilities, L"physical_height", 1'080);
  set_bool(capabilities, L"hardware_accelerated", true);
  set_bool(capabilities, L"keeps_surfaces_native", true);
  set_bool(capabilities, L"supports_pause_resume", true);
  set_bool(capabilities, L"supports_microphone", wasapi_role_available(V4AudioRole::microphone));
  set_bool(capabilities, L"supports_system_audio", wasapi_role_available(V4AudioRole::system));
  set_string(capabilities, L"encoder_id", encoder);
  JsonObject event;
  set_string(event, L"type", L"capabilities");
  event.SetNamedValue(L"capabilities", capabilities);
  writer.emit(std::move(event));
}

void emit_v4_evidence(EventWriter& writer, std::wstring_view session_id,
                      const CaptureOptions& options, const NativeCaptureEvidence& evidence) {
  JsonObject value;
  set_string(value, L"artifact_path", evidence.artifact_path);
  value.SetNamedValue(L"encoder", v4_encoder_evidence(options, evidence));
  value.SetNamedValue(L"cadence", v4_cadence_evidence(evidence));
  winrt::Windows::Data::Json::JsonArray audio;
  for (const auto& entry : evidence.audio) audio.Append(v4_audio_evidence(entry));
  value.SetNamedValue(L"audio", audio);
  set_bool(value, L"finalized", true);
  winrt::Windows::Data::Json::JsonArray failures;
  if (evidence.average_bitrate_bps < options.minimum_bitrate_bps ||
      evidence.average_bitrate_bps > options.maximum_bitrate_bps ||
      evidence.peak_bitrate_bps > options.maximum_bitrate_bps) {
    failures.Append(JsonValue::CreateStringValue(L"bitrate_outside_envelope"));
  }
  value.SetNamedValue(L"failure_codes", failures);
  JsonObject event;
  set_string(event, L"type", L"finalized");
  set_string(event, L"session_id", session_id);
  event.SetNamedValue(L"evidence", value);
  writer.emit(std::move(event));
}

std::wstring_view v4_failure_code(std::string_view code) {
  if (code == "encoder_unavailable") return L"hardware_encoder_unavailable";
  if (code == "backend_unavailable" || code == "backend_capability_mismatch") {
    return L"helper_unavailable";
  }
  if (code == "initial_surface_missing") return L"encoder_warmup_failed";
  return {};
}

}  // namespace

int run_stdio() {
  _setmode(_fileno(stdin), _O_U8TEXT);
  _setmode(_fileno(stdout), _O_U8TEXT);
  winrt::init_apartment(winrt::apartment_type::multi_threaded);
  EventWriter writer;
  emit_hello(writer);
  std::unique_ptr<CaptureSession> active;
  std::wstring active_session_id;
  std::wstring last_stopped_session_id;

  std::wstring line;
  while (std::getline(std::wcin, line)) {
    if (line.empty()) continue;
    try {
      const auto command = parse_command(line);
      const auto type = required_string(command, L"type");
      if (type == L"probe") {
        if (active) throw ProtocolError("contract_mismatch", "cannot probe an active session");
        auto options = parse_options(command);
        options.session_id = L"probe-" + std::to_wstring(GetCurrentProcessId());
        const auto duration_ms = required_uint32(command, L"duration_ms");
        CaptureSession probe(options, writer, true);
        probe.start();
        std::this_thread::sleep_for(std::chrono::milliseconds(duration_ms));
        probe.stop();
        emit_probe_result(writer, probe.observation(), duration_ms, options.requested_width,
                          options.requested_height);
        continue;
      }
      if (type == L"start") {
        if (active) throw ProtocolError("contract_mismatch", "capture session is already active");
        auto options = parse_options(command);
        options.session_id = required_string(command, L"session_id");
        active = std::make_unique<CaptureSession>(options, writer, false);
        active_session_id = options.session_id;
        emit_clock_anchor(writer, options);
        emit_ready(writer, options, *active->ring());
        active->start();
        continue;
      }
      if (type == L"shutdown") {
        if (active) active->stop();
        break;
      }
      const auto command_session_id = required_string(command, L"session_id");
      if (type == L"stop" && !active && command_session_id == last_stopped_session_id) {
        emit_lifecycle(writer, L"stopped", command_session_id);
        continue;
      }
      if (!active || command_session_id != active_session_id) {
        throw ProtocolError("contract_mismatch", "capture session identity mismatch");
      }
      if (type == L"pause") {
        active->pause();
        emit_lifecycle(writer, L"paused", active_session_id);
      } else if (type == L"resume") {
        active->resume();
        emit_lifecycle(writer, L"resumed", active_session_id);
      } else if (type == L"stop") {
        active->stop();
        emit_lifecycle(writer, L"stopped", active_session_id);
        last_stopped_session_id = active_session_id;
        active.reset();
        active_session_id.clear();
      } else {
        throw ProtocolError("contract_mismatch", "unknown helper command");
      }
    } catch (const ProtocolError& error) {
      writer.failure(active_session_id, widen(error.failure_code()), widen(error.what()));
    } catch (const winrt::hresult_error& error) {
      const auto code = error.code() == E_ACCESSDENIED ? L"permission_denied" : L"backend_unavailable";
      writer.failure(active_session_id, code, error.message().c_str());
    } catch (const std::exception& error) {
      writer.failure(active_session_id, L"backend_unavailable", widen(error.what()));
    }
  }
  if (active) active->stop();
  return 0;
}

int run_stdio_v3() {
  _setmode(_fileno(stdin), _O_U8TEXT);
  _setmode(_fileno(stdout), _O_U8TEXT);
  winrt::init_apartment(winrt::apartment_type::multi_threaded);
  EventWriter writer(3);
  emit_hello(writer);
  std::unique_ptr<CaptureSession> active;
  std::wstring active_session_id;

  std::wstring line;
  while (std::getline(std::wcin, line)) {
    if (line.empty()) continue;
    try {
      const auto command = parse_command(line, 3);
      const auto type = required_string(command, L"type");
      if (type == L"capabilities") {
        if (active) throw ProtocolError("contract_mismatch", "cannot probe an active session");
        emit_native_capabilities(writer);
        continue;
      }
      if (type == L"start") {
        if (active) throw ProtocolError("contract_mismatch", "capture session is already active");
        auto options = parse_native_options(command);
        active_session_id = options.session_id;
        active = std::make_unique<CaptureSession>(std::move(options), writer, false);
        try {
          active->start();
          active->wait_for_initial_surface(std::chrono::seconds(5));
        } catch (...) {
          try {
            active->stop();
          } catch (...) {
          }
          active.reset();
          throw;
        }
        emit_lifecycle(writer, L"started", active_session_id);
        continue;
      }
      if (type == L"shutdown") break;
      const auto command_session_id = required_string(command, L"session_id");
      if (!active || command_session_id != active_session_id) {
        throw ProtocolError("contract_mismatch", "capture session identity mismatch");
      }
      if (type == L"pause") {
        active->pause();
        emit_lifecycle(writer, L"paused", active_session_id);
      } else if (type == L"resume") {
        active->resume();
        emit_lifecycle(writer, L"resumed", active_session_id);
      } else if (type == L"stop") {
        active->stop();
        const auto evidence = active->finalize_native_mp4();
        emit_native_evidence(writer, active_session_id, evidence);
        active.reset();
        active_session_id.clear();
      } else {
        throw ProtocolError("contract_mismatch", "unknown helper command");
      }
    } catch (const ProtocolError& error) {
      writer.failure(active_session_id, widen(error.failure_code()), widen(error.what()));
    } catch (const winrt::hresult_error& error) {
      const auto code = error.code() == E_ACCESSDENIED ? L"permission_denied" : L"backend_unavailable";
      writer.failure(active_session_id, code, error.message().c_str());
    } catch (const std::exception& error) {
      writer.failure(active_session_id, L"backend_unavailable", widen(error.what()));
    }
  }
  if (active) active->stop();
  return 0;
}

int run_stdio_v4() {
  _setmode(_fileno(stdin), _O_U8TEXT);
  _setmode(_fileno(stdout), _O_U8TEXT);
  winrt::init_apartment(winrt::apartment_type::multi_threaded);
  EventWriter writer(4);
  emit_hello(writer);
  std::unique_ptr<CaptureSession> active;
  CaptureOptions active_options;
  std::wstring active_session_id;

  std::wstring line;
  while (std::getline(std::wcin, line)) {
    if (line.empty()) continue;
    try {
      const auto command = parse_command(line, 4);
      const auto type = required_string(command, L"type");
      if (type == L"capabilities") {
        require_exact_keys(command, {L"version", L"type"});
        if (active) throw ProtocolError("illegal_transition", "cannot inspect capabilities while capturing");
        emit_v4_capabilities(writer);
        continue;
      }
      if (type == L"warmup") {
        require_exact_keys(command, {L"version", L"type", L"duration_ms", L"session_id",
                                     L"output_path", L"target", L"target_identity",
                                     L"include_cursor", L"requested_audio_roles",
                                     L"encoder_envelope"});
        if (active) throw ProtocolError("illegal_transition", "cannot warm up while capturing");
        auto options = parse_v4_options(command);
        const auto duration_ms = required_uint32(command, L"duration_ms");
        CaptureSession warmup(options, writer, false);
        warmup.start();
        warmup.wait_for_initial_surface(std::chrono::seconds(5));
        std::this_thread::sleep_for(std::chrono::milliseconds(duration_ms));
        warmup.stop();
        const auto evidence = warmup.finalize_native_mp4();
        JsonObject event;
        set_string(event, L"type", L"warmup-result");
        set_string(event, L"session_id", options.session_id);
        set_bool(event, L"passed", evidence.output_frames > 0 &&
                                      evidence.average_bitrate_bps >= options.minimum_bitrate_bps &&
                                      evidence.average_bitrate_bps <= options.maximum_bitrate_bps);
        event.SetNamedValue(L"encoder", v4_encoder_evidence(options, evidence));
        winrt::Windows::Data::Json::JsonArray roles;
        if (wasapi_role_available(V4AudioRole::microphone)) {
          roles.Append(JsonValue::CreateStringValue(L"microphone"));
        }
        if (wasapi_role_available(V4AudioRole::system)) {
          roles.Append(JsonValue::CreateStringValue(L"system"));
        }
        event.SetNamedValue(L"available_audio_roles", roles);
        winrt::Windows::Data::Json::JsonArray failures;
        if (evidence.average_bitrate_bps < options.minimum_bitrate_bps ||
            evidence.average_bitrate_bps > options.maximum_bitrate_bps) {
          failures.Append(JsonValue::CreateStringValue(L"bitrate_outside_envelope"));
        }
        event.SetNamedValue(L"failure_codes", failures);
        writer.emit(std::move(event));
        std::error_code ignored;
        std::filesystem::remove(evidence.artifact_path, ignored);
        for (const auto& audio : evidence.audio) {
          std::filesystem::remove(audio.artifact_path, ignored);
        }
        continue;
      }
      if (type == L"start") {
        require_exact_keys(command, {L"version", L"type", L"session_id", L"output_path",
                                     L"target", L"target_identity", L"include_cursor",
                                     L"requested_audio_roles", L"encoder_envelope"});
        if (active) throw ProtocolError("illegal_transition", "capture session is already active");
        active_options = parse_v4_options(command);
        active_session_id = active_options.session_id;
        active = std::make_unique<CaptureSession>(active_options, writer, false);
        try {
          active->start();
          active->wait_for_initial_surface(std::chrono::seconds(5));
        } catch (...) {
          try {
            active->stop();
          } catch (...) {
          }
          active.reset();
          throw;
        }
        emit_lifecycle(writer, L"started", active_session_id);
        continue;
      }
      if (type == L"shutdown") {
        require_exact_keys(command, {L"version", L"type", L"session_id"});
        if (active) throw ProtocolError("illegal_transition", "shutdown requires no active session");
        break;
      }
      const auto command_session_id = required_string(command, L"session_id");
      require_exact_keys(command, {L"version", L"type", L"session_id"});
      if (!active || command_session_id != active_session_id) {
        throw ProtocolError("contract_mismatch", "capture session identity mismatch");
      }
      if (type == L"pause") {
        active->pause();
        emit_lifecycle(writer, L"paused", active_session_id);
      } else if (type == L"resume") {
        active->resume();
        emit_lifecycle(writer, L"resumed", active_session_id);
      } else if (type == L"stop") {
        active->stop();
        const auto evidence = active->finalize_native_mp4();
        emit_v4_evidence(writer, active_session_id, active_options, evidence);
        active.reset();
        active_session_id.clear();
      } else if (type == L"cancel") {
        active->stop();
        active.reset();
        emit_lifecycle(writer, L"cancelled", active_session_id);
        active_session_id.clear();
      } else {
        throw ProtocolError("contract_mismatch", "unknown V4 helper command");
      }
    } catch (const ProtocolError& error) {
      const auto mapped = v4_failure_code(error.failure_code());
      if (mapped.empty()) {
        writer.failure(active_session_id, widen(error.failure_code()), widen(error.what()));
      } else {
        writer.failure(active_session_id, mapped, widen(error.what()));
      }
    } catch (const winrt::hresult_error& error) {
      const auto code = error.code() == E_ACCESSDENIED ? L"permission_denied" : L"helper_unavailable";
      writer.failure(active_session_id, code, error.message().c_str());
    } catch (const std::exception& error) {
      writer.failure(active_session_id, L"helper_unavailable", widen(error.what()));
    }
  }
  if (active) active->stop();
  return 0;
}

}  // namespace storycapture::wgc

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 64;
  if (std::wstring_view(argv[1]) == L"--stdio-v2") return storycapture::wgc::run_stdio();
  if (std::wstring_view(argv[1]) == L"--stdio-v3") return storycapture::wgc::run_stdio_v3();
  if (std::wstring_view(argv[1]) == L"--stdio-v4") return storycapture::wgc::run_stdio_v4();
  return 64;
}
