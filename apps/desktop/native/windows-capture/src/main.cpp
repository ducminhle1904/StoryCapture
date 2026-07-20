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

}  // namespace storycapture::wgc

int wmain(int argc, wchar_t** argv) {
  if (argc != 2 || std::wstring_view(argv[1]) != L"--stdio-v2") return 64;
  return storycapture::wgc::run_stdio();
}
