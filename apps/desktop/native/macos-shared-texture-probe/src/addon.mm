#include <node_api.h>

#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>
#include <mach/mach.h>
#include <fcntl.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <limits>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

extern char** environ;

namespace {

constexpr uint32_t kProtocolVersion = 1;
constexpr size_t kPoolSlots = 2;
constexpr size_t kMaxReadyQueueDepth = 1;
constexpr uint32_t kMarkerBits = 20;
constexpr uint32_t kMarkerTileSize = 16;

struct FrameSlot {
  std::vector<uint8_t> bytes;
};

uint64_t ResidentBytes() {
  mach_task_basic_info_data_t info{};
  mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
  const kern_return_t result = task_info(
      mach_task_self(), MACH_TASK_BASIC_INFO, reinterpret_cast<task_info_t>(&info), &count);
  return result == KERN_SUCCESS ? info.resident_size : 0;
}

double Percentile(std::vector<double> values, double percentile) {
  if (values.empty()) return 0.0;
  std::sort(values.begin(), values.end());
  const double rank = percentile * static_cast<double>(values.size() - 1);
  const size_t lower = static_cast<size_t>(std::floor(rank));
  const size_t upper = static_cast<size_t>(std::ceil(rank));
  if (lower == upper) return values[lower];
  const double fraction = rank - static_cast<double>(lower);
  return values[lower] + ((values[upper] - values[lower]) * fraction);
}

bool WriteAll(int fd, const uint8_t* bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    const ssize_t written = write(fd, bytes + offset, length - offset);
    if (written > 0) {
      offset += static_cast<size_t>(written);
      continue;
    }
    if (written < 0 && errno == EINTR) continue;
    return false;
  }
  return true;
}

class ProbeSession {
 public:
  ProbeSession(uint32_t width,
               uint32_t height,
               std::string ffmpeg_path,
               std::string output_path)
      : width_(width),
        height_(height),
        frame_bytes_(static_cast<size_t>(width) * static_cast<size_t>(height) * 4) {
    slots_.resize(kPoolSlots);
    for (size_t index = 0; index < slots_.size(); ++index) {
      slots_[index].bytes.resize(frame_bytes_);
      free_slots_.push_back(index);
    }
    baseline_resident_bytes_ = ResidentBytes();
    peak_resident_bytes_ = baseline_resident_bytes_;
    if (!StartFfmpeg(ffmpeg_path, output_path)) return;
    worker_ = std::thread([this] { WriterLoop(); });
  }

  ProbeSession(const ProbeSession&) = delete;
  ProbeSession& operator=(const ProbeSession&) = delete;

  ~ProbeSession() { Abort(); }

  bool started() const { return started_; }

  std::string failure_reason() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return failure_reason_;
  }

  bool Submit(IOSurfaceRef surface,
              uint64_t frame_count,
              int64_t timestamp_us,
              uint32_t* marker_ordinal,
              double* service_time_ms) {
    const auto started_at = std::chrono::steady_clock::now();
    size_t slot_index = 0;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!started_ || finishing_ || finished_ || failed_) {
        SetFailureLocked("native session is not accepting frames");
        return false;
      }
      if (ready_slots_.size() >= kMaxReadyQueueDepth || free_slots_.empty()) {
        ++queue_overflows_;
        SetFailureLocked("bounded native frame pool overflowed");
        return false;
      }
      slot_index = free_slots_.front();
      free_slots_.pop_front();
    }

    CFRetain(surface);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      ++handles_imported_;
      ++active_leases_;
      peak_active_leases_ = std::max(peak_active_leases_, active_leases_);
    }

    bool locked = false;
    bool copied = false;
    const IOReturn lock_result = IOSurfaceLock(surface, kIOSurfaceLockReadOnly, nullptr);
    if (lock_result == kIOReturnSuccess) {
      locked = true;
      const size_t surface_width = IOSurfaceGetWidth(surface);
      const size_t surface_height = IOSurfaceGetHeight(surface);
      const size_t bytes_per_row = IOSurfaceGetBytesPerRow(surface);
      const auto* base_address = static_cast<const uint8_t*>(IOSurfaceGetBaseAddress(surface));
      if (surface_width == width_ && surface_height == height_ &&
          bytes_per_row >= static_cast<size_t>(width_) * 4 && base_address != nullptr) {
        auto& destination = slots_[slot_index].bytes;
        const size_t packed_row_bytes = static_cast<size_t>(width_) * 4;
        for (uint32_t row = 0; row < height_; ++row) {
          std::memcpy(destination.data() + (static_cast<size_t>(row) * packed_row_bytes),
                      base_address + (static_cast<size_t>(row) * bytes_per_row), packed_row_bytes);
        }
        *marker_ordinal = DecodeMarker(destination);
        copied = true;
      }
    }
    if (locked) IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, nullptr);
    CFRelease(surface);

    {
      std::lock_guard<std::mutex> lock(mutex_);
      ++handles_released_;
      --active_leases_;
      if (!copied) {
        free_slots_.push_back(slot_index);
        SetFailureLocked("IOSurface readback did not match the 1920x1080 BGRA contract");
        return false;
      }
      ready_slots_.push_back(slot_index);
      max_ready_queue_depth_ = std::max(max_ready_queue_depth_, ready_slots_.size());
      ++native_accepted_frames_;
      last_frame_count_ = frame_count;
      last_timestamp_us_ = timestamp_us;
      const auto ended_at = std::chrono::steady_clock::now();
      *service_time_ms = std::chrono::duration<double, std::milli>(ended_at - started_at).count();
      service_times_ms_.push_back(*service_time_ms);
      const uint64_t resident_bytes = ResidentBytes();
      peak_resident_bytes_ = std::max(peak_resident_bytes_, resident_bytes);
    }
    condition_.notify_one();
    return true;
  }

  void Finish() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (finished_) return;
      finishing_ = true;
    }
    condition_.notify_all();
    if (worker_.joinable()) worker_.join();
    CloseFfmpegInput();
    WaitForFfmpeg();
    std::lock_guard<std::mutex> lock(mutex_);
    final_resident_bytes_ = ResidentBytes();
    peak_resident_bytes_ = std::max(peak_resident_bytes_, final_resident_bytes_);
    finished_ = true;
  }

  void Abort() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (finished_) return;
      finishing_ = true;
      aborted_ = true;
      while (!ready_slots_.empty()) {
        free_slots_.push_back(ready_slots_.front());
        ready_slots_.pop_front();
      }
    }
    condition_.notify_all();
    if (worker_.joinable()) worker_.join();
    CloseFfmpegInput();
    if (ffmpeg_pid_ > 0) kill(ffmpeg_pid_, SIGTERM);
    WaitForFfmpeg();
    std::lock_guard<std::mutex> lock(mutex_);
    final_resident_bytes_ = ResidentBytes();
    finished_ = true;
  }

  napi_value Stats(napi_env env) const;

 private:
  bool StartFfmpeg(const std::string& ffmpeg_path, const std::string& output_path) {
    int stdin_pipe[2] = {-1, -1};
    if (pipe(stdin_pipe) != 0) {
      failure_reason_ = "failed to create FFmpeg stdin pipe";
      failed_ = true;
      return false;
    }

    const std::string size = std::to_string(width_) + "x" + std::to_string(height_);
    std::vector<std::string> arguments = {
        ffmpeg_path, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo",
        "-pixel_format", "bgra", "-video_size", size, "-framerate", "60/1", "-i",
        "pipe:0", "-an", "-c:v", "ffv1", "-level", "3", "-g", "1", "-slices",
        "16", "-slicecrc", "1", "-pix_fmt", "bgra", "-r", "60/1", output_path};
    std::vector<char*> argv;
    argv.reserve(arguments.size() + 1);
    for (auto& argument : arguments) argv.push_back(argument.data());
    argv.push_back(nullptr);

    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    posix_spawn_file_actions_adddup2(&actions, stdin_pipe[0], STDIN_FILENO);
    posix_spawn_file_actions_addclose(&actions, stdin_pipe[1]);
    posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0);
    posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0);
    const int spawn_result =
        posix_spawn(&ffmpeg_pid_, ffmpeg_path.c_str(), &actions, nullptr, argv.data(), environ);
    posix_spawn_file_actions_destroy(&actions);
    close(stdin_pipe[0]);
    if (spawn_result != 0) {
      close(stdin_pipe[1]);
      ffmpeg_pid_ = -1;
      failure_reason_ = "failed to launch packaged FFmpeg: " + std::to_string(spawn_result);
      failed_ = true;
      return false;
    }
    ffmpeg_stdin_fd_ = stdin_pipe[1];
    ffmpeg_launched_ = true;
    started_ = true;
    return true;
  }

  void WriterLoop() {
    while (true) {
      size_t slot_index = 0;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        condition_.wait(lock, [this] { return finishing_ || failed_ || !ready_slots_.empty(); });
        if ((finishing_ || failed_) && ready_slots_.empty()) return;
        slot_index = ready_slots_.front();
        ready_slots_.pop_front();
      }

      const bool wrote = WriteAll(ffmpeg_stdin_fd_, slots_[slot_index].bytes.data(), frame_bytes_);
      {
        std::lock_guard<std::mutex> lock(mutex_);
        free_slots_.push_back(slot_index);
        if (!wrote) {
          SetFailureLocked("packaged FFmpeg stdin write failed");
          while (!ready_slots_.empty()) {
            free_slots_.push_back(ready_slots_.front());
            ready_slots_.pop_front();
          }
        } else {
          ++ffmpeg_enqueued_frames_;
        }
      }
      if (!wrote) return;
    }
  }

  uint32_t DecodeMarker(const std::vector<uint8_t>& bytes) const {
    uint32_t ordinal = 0;
    const size_t row_bytes = static_cast<size_t>(width_) * 4;
    const size_t sample_y = kMarkerTileSize / 2;
    for (uint32_t bit = 0; bit < kMarkerBits; ++bit) {
      const size_t sample_x = (static_cast<size_t>(bit) * kMarkerTileSize) + (kMarkerTileSize / 2);
      const size_t offset = (sample_y * row_bytes) + (sample_x * 4);
      const uint32_t luminance = static_cast<uint32_t>(bytes[offset]) +
                                 static_cast<uint32_t>(bytes[offset + 1]) +
                                 static_cast<uint32_t>(bytes[offset + 2]);
      if (luminance >= (3 * 128)) ordinal |= (1u << bit);
    }
    return ordinal;
  }

  void SetFailureLocked(std::string reason) {
    if (failure_reason_.empty()) failure_reason_ = std::move(reason);
    failed_ = true;
  }

  void CloseFfmpegInput() {
    if (ffmpeg_stdin_fd_ >= 0) {
      close(ffmpeg_stdin_fd_);
      ffmpeg_stdin_fd_ = -1;
    }
  }

  void WaitForFfmpeg() {
    if (ffmpeg_pid_ <= 0 || ffmpeg_waited_) return;
    int status = 0;
    while (waitpid(ffmpeg_pid_, &status, 0) < 0 && errno == EINTR) {
    }
    ffmpeg_waited_ = true;
    if (WIFEXITED(status)) {
      ffmpeg_exit_code_ = WEXITSTATUS(status);
    } else if (WIFSIGNALED(status)) {
      ffmpeg_exit_code_ = 128 + WTERMSIG(status);
    } else {
      ffmpeg_exit_code_ = -1;
    }
    if (!aborted_ && ffmpeg_exit_code_ != 0) {
      std::lock_guard<std::mutex> lock(mutex_);
      SetFailureLocked("packaged FFmpeg exited unsuccessfully");
    }
  }

  uint32_t width_;
  uint32_t height_;
  size_t frame_bytes_;
  std::vector<FrameSlot> slots_;
  std::deque<size_t> free_slots_;
  std::deque<size_t> ready_slots_;
  mutable std::mutex mutex_;
  std::condition_variable condition_;
  std::thread worker_;
  pid_t ffmpeg_pid_ = -1;
  int ffmpeg_stdin_fd_ = -1;
  bool started_ = false;
  bool finishing_ = false;
  bool finished_ = false;
  bool failed_ = false;
  bool aborted_ = false;
  bool ffmpeg_launched_ = false;
  bool ffmpeg_waited_ = false;
  int ffmpeg_exit_code_ = std::numeric_limits<int>::min();
  std::string failure_reason_;
  uint64_t handles_imported_ = 0;
  uint64_t handles_released_ = 0;
  uint64_t active_leases_ = 0;
  uint64_t peak_active_leases_ = 0;
  uint64_t native_accepted_frames_ = 0;
  uint64_t ffmpeg_enqueued_frames_ = 0;
  uint64_t queue_overflows_ = 0;
  size_t max_ready_queue_depth_ = 0;
  uint64_t last_frame_count_ = 0;
  int64_t last_timestamp_us_ = 0;
  uint64_t baseline_resident_bytes_ = 0;
  uint64_t peak_resident_bytes_ = 0;
  uint64_t final_resident_bytes_ = 0;
  std::vector<double> service_times_ms_;
};

void SetNamedNumber(napi_env env, napi_value object, const char* name, double value) {
  napi_value result;
  napi_create_double(env, value, &result);
  napi_set_named_property(env, object, name, result);
}

void SetNamedBoolean(napi_env env, napi_value object, const char* name, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  napi_set_named_property(env, object, name, result);
}

void SetNamedString(napi_env env, napi_value object, const char* name, const std::string& value) {
  napi_value result;
  napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  napi_set_named_property(env, object, name, result);
}

napi_value ProbeSession::Stats(napi_env env) const {
  std::lock_guard<std::mutex> lock(mutex_);
  napi_value stats;
  napi_create_object(env, &stats);
  SetNamedNumber(env, stats, "handlesImported", static_cast<double>(handles_imported_));
  SetNamedNumber(env, stats, "handlesReleased", static_cast<double>(handles_released_));
  SetNamedNumber(env, stats, "activeLeases", static_cast<double>(active_leases_));
  SetNamedNumber(env, stats, "peakActiveLeases", static_cast<double>(peak_active_leases_));
  SetNamedNumber(env, stats, "nativeAcceptedFrames", static_cast<double>(native_accepted_frames_));
  SetNamedNumber(env, stats, "ffmpegEnqueuedFrames", static_cast<double>(ffmpeg_enqueued_frames_));
  SetNamedNumber(env, stats, "queueOverflows", static_cast<double>(queue_overflows_));
  SetNamedNumber(env, stats, "maxReadyQueueDepth", static_cast<double>(max_ready_queue_depth_));
  SetNamedNumber(env, stats, "lastFrameCount", static_cast<double>(last_frame_count_));
  SetNamedNumber(env, stats, "lastTimestampUs", static_cast<double>(last_timestamp_us_));
  SetNamedNumber(env, stats, "serviceTimeP95Ms", Percentile(service_times_ms_, 0.95));
  SetNamedNumber(env, stats, "serviceTimeP99Ms", Percentile(service_times_ms_, 0.99));
  SetNamedNumber(env, stats, "serviceTimeMaxMs", Percentile(service_times_ms_, 1.0));
  SetNamedNumber(env, stats, "boundedPoolBytes", static_cast<double>(frame_bytes_ * kPoolSlots));
  SetNamedNumber(env, stats, "baselineResidentBytes", static_cast<double>(baseline_resident_bytes_));
  SetNamedNumber(env, stats, "peakResidentBytes", static_cast<double>(peak_resident_bytes_));
  SetNamedNumber(env, stats, "finalResidentBytes", static_cast<double>(final_resident_bytes_));
  SetNamedBoolean(env, stats, "ffmpegLaunched", ffmpeg_launched_);
  SetNamedNumber(env, stats, "ffmpegExitCode", static_cast<double>(ffmpeg_exit_code_));
  SetNamedBoolean(env, stats, "failed", failed_);
  SetNamedString(env, stats, "failureReason", failure_reason_);
  return stats;
}

napi_value ThrowTypeError(napi_env env, const char* message) {
  napi_throw_type_error(env, nullptr, message);
  return nullptr;
}

napi_value ThrowError(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
  return nullptr;
}

bool NamedValue(napi_env env, napi_value object, const char* name, napi_value* value) {
  bool has_property = false;
  return napi_has_named_property(env, object, name, &has_property) == napi_ok && has_property &&
         napi_get_named_property(env, object, name, value) == napi_ok;
}

bool NamedNumber(napi_env env, napi_value object, const char* name, double* value) {
  napi_value property;
  return NamedValue(env, object, name, &property) && napi_get_value_double(env, property, value) == napi_ok;
}

bool NamedString(napi_env env, napi_value object, const char* name, std::string* value) {
  napi_value property;
  if (!NamedValue(env, object, name, &property)) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, property, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char> bytes(length + 1);
  if (napi_get_value_string_utf8(env, property, bytes.data(), bytes.size(), &length) != napi_ok) return false;
  value->assign(bytes.data(), length);
  return true;
}

ProbeSession* UnwrapSession(napi_env env, napi_callback_info info, napi_value* argument = nullptr) {
  size_t argc = argument == nullptr ? 0 : 1;
  napi_value this_value;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, &this_value, nullptr) != napi_ok) return nullptr;
  ProbeSession* session = nullptr;
  if (napi_unwrap(env, this_value, reinterpret_cast<void**>(&session)) != napi_ok) return nullptr;
  if (argument != nullptr && argc == 1) *argument = args[0];
  return session;
}

void FinalizeSession(napi_env env, void* data, void* hint) {
  delete static_cast<ProbeSession*>(data);
}

napi_value SubmitFrame(napi_env env, napi_callback_info info) {
  napi_value frame;
  ProbeSession* session = UnwrapSession(env, info, &frame);
  if (session == nullptr) return ThrowError(env, "invalid native probe session");

  napi_value handle_value;
  if (!NamedValue(env, frame, "ioSurface", &handle_value)) {
    return ThrowTypeError(env, "ioSurface Buffer is required");
  }
  void* handle_bytes = nullptr;
  size_t handle_length = 0;
  if (napi_get_buffer_info(env, handle_value, &handle_bytes, &handle_length) != napi_ok ||
      handle_length != sizeof(uintptr_t)) {
    return ThrowTypeError(env, "ioSurface must be a pointer-sized Buffer");
  }
  uintptr_t pointer = 0;
  std::memcpy(&pointer, handle_bytes, sizeof(pointer));
  if (pointer == 0) return ThrowTypeError(env, "ioSurface pointer is null");

  double frame_count = 0;
  double timestamp_us = 0;
  if (!NamedNumber(env, frame, "frameCount", &frame_count) || frame_count < 0 ||
      std::floor(frame_count) != frame_count) {
    return ThrowTypeError(env, "frameCount must be a non-negative integer");
  }
  if (!NamedNumber(env, frame, "timestampUs", &timestamp_us) || timestamp_us < 0 ||
      std::floor(timestamp_us) != timestamp_us) {
    return ThrowTypeError(env, "timestampUs must be a non-negative integer");
  }

  uint32_t marker_ordinal = 0;
  double service_time_ms = 0;
  if (!session->Submit(reinterpret_cast<IOSurfaceRef>(pointer), static_cast<uint64_t>(frame_count),
                       static_cast<int64_t>(timestamp_us), &marker_ordinal, &service_time_ms)) {
    return ThrowError(env, session->failure_reason());
  }
  napi_value receipt;
  napi_create_object(env, &receipt);
  SetNamedNumber(env, receipt, "frameCount", frame_count);
  SetNamedNumber(env, receipt, "timestampUs", timestamp_us);
  SetNamedNumber(env, receipt, "markerOrdinal", marker_ordinal);
  SetNamedNumber(env, receipt, "serviceTimeMs", service_time_ms);
  return receipt;
}

napi_value Finish(napi_env env, napi_callback_info info) {
  ProbeSession* session = UnwrapSession(env, info);
  if (session == nullptr) return ThrowError(env, "invalid native probe session");
  session->Finish();
  return session->Stats(env);
}

napi_value Abort(napi_env env, napi_callback_info info) {
  ProbeSession* session = UnwrapSession(env, info);
  if (session == nullptr) return ThrowError(env, "invalid native probe session");
  session->Abort();
  return session->Stats(env);
}

napi_value GetStats(napi_env env, napi_callback_info info) {
  ProbeSession* session = UnwrapSession(env, info);
  if (session == nullptr) return ThrowError(env, "invalid native probe session");
  return session->Stats(env);
}

napi_value CreateSession(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1) {
    return ThrowTypeError(env, "session options are required");
  }
  double width = 0;
  double height = 0;
  std::string ffmpeg_path;
  std::string output_path;
  if (!NamedNumber(env, args[0], "width", &width) || !NamedNumber(env, args[0], "height", &height) ||
      width != 1920 || height != 1080) {
    return ThrowTypeError(env, "probe requires exact 1920x1080 dimensions");
  }
  if (!NamedString(env, args[0], "ffmpegPath", &ffmpeg_path) || ffmpeg_path.empty() ||
      !NamedString(env, args[0], "outputPath", &output_path) || output_path.empty()) {
    return ThrowTypeError(env, "ffmpegPath and outputPath are required");
  }

  auto* session = new ProbeSession(static_cast<uint32_t>(width), static_cast<uint32_t>(height),
                                   std::move(ffmpeg_path), std::move(output_path));
  if (!session->started()) {
    const std::string reason = session->failure_reason();
    delete session;
    return ThrowError(env, reason);
  }

  napi_value object;
  napi_create_object(env, &object);
  if (napi_wrap(env, object, session, FinalizeSession, nullptr, nullptr) != napi_ok) {
    delete session;
    return ThrowError(env, "failed to wrap native probe session");
  }
  const napi_property_descriptor methods[] = {
      {"submitFrame", nullptr, SubmitFrame, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"finish", nullptr, Finish, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"abort", nullptr, Abort, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getStats", nullptr, GetStats, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, object, sizeof(methods) / sizeof(methods[0]), methods);
  return object;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor create_session = {
      "createSession", nullptr, CreateSession, nullptr, nullptr, nullptr, napi_default, nullptr};
  napi_define_properties(env, exports, 1, &create_session);
  SetNamedNumber(env, exports, "protocolVersion", kProtocolVersion);
  return exports;
}

}  // namespace

NAPI_MODULE(storycapture_shared_texture_probe, Init)
