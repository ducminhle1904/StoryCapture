#include <node_api.h>

#include <CommonCrypto/CommonDigest.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <pthread.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <iomanip>
#include <limits>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

extern char** environ;

namespace {

constexpr uint32_t kProtocolVersion = 3;
constexpr char kProtocolHash[] =
    "f444d47f4f6d2cc71b709dc4677593e5047b8a61e34c76d7190fead3cf899c42";
constexpr size_t kMaxQueuedLeases = 1;
constexpr size_t kFramePoolSlots = 2;
constexpr size_t kMaxCompletedReceipts = 8;
constexpr uint32_t kMaximumWidth = 1920;
constexpr uint32_t kMaximumHeight = 1080;
constexpr size_t kMaximumPhysicalPixels = static_cast<size_t>(kMaximumWidth) * kMaximumHeight;
constexpr size_t kBgraBytesPerPixel = 4;
constexpr double kNativeDeadlineMs = 16.67;
constexpr auto kLeaseAdmissionDeadline = std::chrono::microseconds(11'110);
constexpr auto kPauseDrainDeadline = std::chrono::seconds(1);

struct FrameMetadata {
  uint64_t source_epoch = 0;
  uint64_t active_segment = 0;
  uint64_t source_frame_count = 0;
  int64_t source_timestamp_us = 0;
  int64_t active_time_pts_us = 0;
  uint64_t delivery_ordinal = 0;
  uint64_t native_lease_ordinal = 0;
};

struct FrameLease {
  IOSurfaceRef surface = nullptr;
  FrameMetadata metadata;
  std::chrono::steady_clock::time_point accepted_at;
};

struct FrameReceipt {
  FrameMetadata metadata;
  uint64_t native_commit_ordinal = 0;
  uint64_t encoded_ordinal = 0;
  std::string bgra_sha256;
  double service_time_ms = 0;
};

struct FrameSlot {
  std::vector<uint8_t> bytes;
  FrameMetadata metadata;
  std::string bgra_sha256;
  double service_time_ms = 0;
};

enum class Lifecycle { kActive, kPaused, kFinishing, kStopped, kAborted };

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

bool FrameByteCount(uint32_t width, uint32_t height, size_t* frame_bytes) {
  if (frame_bytes == nullptr || width == 0 || height == 0 || width > kMaximumWidth ||
      height > kMaximumHeight) {
    return false;
  }
  const size_t physical_pixels = static_cast<size_t>(width) * static_cast<size_t>(height);
  if (physical_pixels > kMaximumPhysicalPixels ||
      physical_pixels > std::numeric_limits<size_t>::max() / kBgraBytesPerPixel) {
    return false;
  }
  *frame_bytes = physical_pixels * kBgraBytesPerPixel;
  return true;
}

std::string Sha256(const std::vector<uint8_t>& bytes) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes.data(), static_cast<CC_LONG>(bytes.size()), digest);
  std::ostringstream output;
  output << std::hex << std::setfill('0');
  for (const unsigned char byte : digest) output << std::setw(2) << static_cast<int>(byte);
  return output.str();
}

class RecordingSession {
 public:
  RecordingSession(uint32_t width,
                   uint32_t height,
                   size_t frame_bytes,
                   std::string ffmpeg_path,
                   std::string output_path)
      : width_(width), height_(height), frame_bytes_(frame_bytes) {
    slots_.resize(kFramePoolSlots);
    for (size_t index = 0; index < slots_.size(); ++index) {
      slots_[index].bytes.resize(frame_bytes_);
      free_slots_.push_back(index);
    }
    if (!StartFfmpeg(ffmpeg_path, output_path)) return;
    readback_worker_ = std::thread([this] { ReadbackLoop(); });
    writer_worker_ = std::thread([this] { WriterLoop(); });
  }

  RecordingSession(const RecordingSession&) = delete;
  RecordingSession& operator=(const RecordingSession&) = delete;
  ~RecordingSession() { Abort(); }

  bool started() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return started_;
  }

  std::string failure_reason() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return failure_reason_;
  }

  std::string failure_code() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return failure_code_;
  }

  bool Submit(IOSurfaceRef surface, FrameMetadata metadata, uint64_t* lease_ordinal) {
    std::unique_lock<std::mutex> lock(mutex_);
    if (lifecycle_ != Lifecycle::kActive || failed_) {
      SetFailureLocked("contract_mismatch", "native V3 session is not accepting frames");
      return false;
    }
    if (queued_leases_.size() >= kMaxQueuedLeases) {
      const auto wait_started_at = std::chrono::steady_clock::now();
      const bool admitted = condition_.wait_for(lock, kLeaseAdmissionDeadline, [this] {
        return queued_leases_.size() < kMaxQueuedLeases || failed_ ||
               lifecycle_ != Lifecycle::kActive;
      });
      const double wait_ms = std::chrono::duration<double, std::milli>(
                                 std::chrono::steady_clock::now() - wait_started_at)
                                 .count();
      ++lease_admission_waits_;
      lease_admission_wait_max_ms_ = std::max(lease_admission_wait_max_ms_, wait_ms);
      if (!admitted) {
        ++lease_overflows_;
        SetFailureLocked("native_lease_overflow",
                         "bounded native IOSurface lease queue overflowed");
        return false;
      }
    }
    if (lifecycle_ != Lifecycle::kActive || failed_) return false;
    if (has_previous_metadata_) {
      if (metadata.source_epoch < previous_metadata_.source_epoch ||
          metadata.active_segment < previous_metadata_.active_segment) {
        SetFailureLocked("source_epoch_violation", "source epoch or segment moved backwards");
        return false;
      }
      if (metadata.source_epoch == previous_metadata_.source_epoch &&
          metadata.active_segment == previous_metadata_.active_segment) {
        if (metadata.source_frame_count != previous_metadata_.source_frame_count + 1) {
          ++source_ordinal_gaps_;
          SetFailureLocked("source_ordinal_gap", "Electron frameCount was not contiguous");
          return false;
        }
        if (metadata.source_timestamp_us <= previous_metadata_.source_timestamp_us) {
          ++source_timestamp_regressions_;
          SetFailureLocked("source_timestamp_regression", "Electron timestamp did not increase");
          return false;
        }
      } else if (metadata.source_epoch == previous_metadata_.source_epoch &&
                 (metadata.source_frame_count <= previous_metadata_.source_frame_count ||
                  metadata.source_timestamp_us <= previous_metadata_.source_timestamp_us)) {
        SetFailureLocked("active_segment_violation",
                         "a resumed segment must advance frameCount and timestamp");
        return false;
      }
    }
    if (metadata.delivery_ordinal != delivery_frames_ ||
        metadata.native_lease_ordinal != native_leases_accepted_) {
      SetFailureLocked("contract_mismatch", "delivery/native lease ordinals were not contiguous");
      return false;
    }

    CFRetain(surface);
    ++handles_imported_;
    ++active_leases_;
    peak_active_leases_ = std::max(peak_active_leases_, active_leases_);
    queued_leases_.push_back({surface, metadata, std::chrono::steady_clock::now()});
    max_queue_depth_ = std::max(max_queue_depth_, queued_leases_.size());
    previous_metadata_ = metadata;
    has_previous_metadata_ = true;
    ++delivery_frames_;
    *lease_ordinal = native_leases_accepted_++;
    condition_.notify_all();
    return true;
  }

  bool Pause() {
    std::unique_lock<std::mutex> lock(mutex_);
    if (lifecycle_ == Lifecycle::kPaused) return true;
    if (lifecycle_ != Lifecycle::kActive || failed_) {
      SetFailureLocked("contract_mismatch", "only an active V3 session can pause");
      return false;
    }
    lifecycle_ = Lifecycle::kPaused;
    condition_.notify_all();
    const bool drained = condition_.wait_for(lock, kPauseDrainDeadline, [this] {
      return failed_ || (queued_leases_.empty() && ready_slots_.empty() && active_leases_ == 0 &&
                         free_slots_.size() == kFramePoolSlots);
    });
    if (!drained) {
      SetFailureLocked("native_backpressure", "native V3 pause did not drain pending frames");
      return false;
    }
    if (failed_) return false;
    return true;
  }

  bool Resume(uint64_t source_epoch, uint64_t active_segment) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (lifecycle_ != Lifecycle::kPaused || failed_) {
      SetFailureLocked("contract_mismatch", "only a paused V3 session can resume");
      return false;
    }
    if (has_previous_metadata_ &&
        (source_epoch < previous_metadata_.source_epoch ||
         active_segment != previous_metadata_.active_segment + 1)) {
      SetFailureLocked("active_segment_violation", "resume requires the next active segment");
      return false;
    }
    lifecycle_ = Lifecycle::kActive;
    return true;
  }

  bool CloseEpoch(uint64_t source_epoch, uint64_t active_segment) {
    std::lock_guard<std::mutex> lock(mutex_);
    if ((lifecycle_ != Lifecycle::kActive && lifecycle_ != Lifecycle::kPaused) || failed_) {
      SetFailureLocked("contract_mismatch", "native V3 session cannot close an epoch now");
      return false;
    }
    if (has_previous_metadata_ &&
        (source_epoch != previous_metadata_.source_epoch + 1 ||
         active_segment != previous_metadata_.active_segment + 1)) {
      SetFailureLocked("source_epoch_violation", "reload requires the next epoch and segment");
      return false;
    }
    return true;
  }

  void Stop() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (lifecycle_ == Lifecycle::kStopped || lifecycle_ == Lifecycle::kAborted) return;
      lifecycle_ = Lifecycle::kFinishing;
    }
    condition_.notify_all();
    if (readback_worker_.joinable()) readback_worker_.join();
    condition_.notify_all();
    if (writer_worker_.joinable()) writer_worker_.join();
    CloseFfmpegInput();
    WaitForFfmpeg();
    std::lock_guard<std::mutex> lock(mutex_);
    lifecycle_ = Lifecycle::kStopped;
  }

  void Abort() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (lifecycle_ == Lifecycle::kStopped || lifecycle_ == Lifecycle::kAborted) return;
      lifecycle_ = Lifecycle::kAborted;
      ReleaseQueuedLeasesLocked();
    }
    condition_.notify_all();
    if (readback_worker_.joinable()) readback_worker_.join();
    if (writer_worker_.joinable()) writer_worker_.join();
    CloseFfmpegInput();
    if (ffmpeg_pid_ > 0 && !ffmpeg_waited_) kill(ffmpeg_pid_, SIGTERM);
    WaitForFfmpeg();
  }

  std::vector<FrameReceipt> DrainReceipts() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<FrameReceipt> receipts;
    receipts.reserve(completed_receipts_.size());
    while (!completed_receipts_.empty()) {
      receipts.push_back(std::move(completed_receipts_.front()));
      completed_receipts_.pop_front();
    }
    return receipts;
  }

  napi_value Stats(napi_env env) const;

 private:
  bool StartFfmpeg(const std::string& ffmpeg_path, const std::string& output_path) {
    int stdin_pipe[2] = {-1, -1};
    if (pipe(stdin_pipe) != 0) {
      failure_code_ = "native_backpressure";
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
      failure_code_ = "native_encoder_exit_nonzero";
      failure_reason_ = "failed to launch FFmpeg: " + std::to_string(spawn_result);
      failed_ = true;
      return false;
    }
    ffmpeg_stdin_fd_ = stdin_pipe[1];
    started_ = true;
    return true;
  }

  void ReadbackLoop() {
    pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
    while (true) {
      FrameLease lease;
      size_t slot_index = 0;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        condition_.wait(lock, [this] {
          return lifecycle_ == Lifecycle::kAborted || failed_ ||
                 (!queued_leases_.empty() && !free_slots_.empty()) ||
                 (lifecycle_ == Lifecycle::kFinishing && queued_leases_.empty());
        });
        if (lifecycle_ == Lifecycle::kAborted || failed_) {
          ReleaseQueuedLeasesLocked();
          readback_finished_ = true;
          condition_.notify_all();
          return;
        }
        if (lifecycle_ == Lifecycle::kFinishing && queued_leases_.empty()) {
          readback_finished_ = true;
          condition_.notify_all();
          return;
        }
        if (failed_) {
          ReleaseQueuedLeasesLocked();
          readback_finished_ = true;
          condition_.notify_all();
          return;
        }
        lease = queued_leases_.front();
        queued_leases_.pop_front();
        slot_index = free_slots_.front();
        free_slots_.pop_front();
        condition_.notify_all();
      }

      bool copied = false;
      bool locked_surface = false;
      size_t surface_width = 0;
      size_t surface_height = 0;
      size_t bytes_per_row = 0;
      auto& slot = slots_[slot_index];
      const IOReturn lock_result = IOSurfaceLock(lease.surface, kIOSurfaceLockReadOnly, nullptr);
      if (lock_result == kIOReturnSuccess) {
        locked_surface = true;
        surface_width = IOSurfaceGetWidth(lease.surface);
        surface_height = IOSurfaceGetHeight(lease.surface);
        bytes_per_row = IOSurfaceGetBytesPerRow(lease.surface);
        const auto* base = static_cast<const uint8_t*>(IOSurfaceGetBaseAddress(lease.surface));
        const size_t packed_row_bytes = static_cast<size_t>(width_) * kBgraBytesPerPixel;
        if (surface_width == width_ && surface_height == height_ && bytes_per_row >= packed_row_bytes &&
            base != nullptr) {
          for (uint32_t row = 0; row < height_; ++row) {
            std::memcpy(slot.bytes.data() + (static_cast<size_t>(row) * packed_row_bytes),
                        base + (static_cast<size_t>(row) * bytes_per_row), packed_row_bytes);
          }
          copied = true;
        }
      }
      if (locked_surface) IOSurfaceUnlock(lease.surface, kIOSurfaceLockReadOnly, nullptr);

      std::string hash = copied ? Sha256(slot.bytes) : std::string();
      const auto completed_at = std::chrono::steady_clock::now();
      const double service_time_ms =
          std::chrono::duration<double, std::milli>(completed_at - lease.accepted_at).count();
      CFRelease(lease.surface);

      std::lock_guard<std::mutex> lock(mutex_);
      ++handles_released_;
      --active_leases_;
      if (!copied) {
        free_slots_.push_back(slot_index);
        std::ostringstream reason;
        reason << "IOSurface readback expected " << width_ << "x" << height_
               << " BGRA; received " << surface_width << "x" << surface_height
               << " with " << bytes_per_row << " bytes per row";
        SetFailureLocked("native_texture_lost", reason.str());
        ReleaseQueuedLeasesLocked();
        readback_finished_ = true;
        condition_.notify_all();
        return;
      }
      if (service_time_ms > kNativeDeadlineMs) {
        free_slots_.push_back(slot_index);
        ++deadline_misses_;
        SetFailureLocked("native_deadline_missed", "native readback/enqueue missed 60 Hz deadline");
        ReleaseQueuedLeasesLocked();
        readback_finished_ = true;
        condition_.notify_all();
        return;
      }
      slot.metadata = lease.metadata;
      slot.bgra_sha256 = std::move(hash);
      slot.service_time_ms = service_time_ms;
      service_times_ms_.push_back(service_time_ms);
      ready_slots_.push_back(slot_index);
      max_ready_queue_depth_ = std::max(max_ready_queue_depth_, ready_slots_.size());
      condition_.notify_all();
    }
  }

  void WriterLoop() {
    pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED, 0);
    while (true) {
      size_t slot_index = 0;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        condition_.wait(lock, [this] {
          return lifecycle_ == Lifecycle::kAborted || failed_ || !ready_slots_.empty() ||
                 readback_finished_;
        });
        if (lifecycle_ == Lifecycle::kAborted || failed_) {
          ReleaseReadySlotsLocked();
          return;
        }
        if (ready_slots_.empty() && readback_finished_) return;
        slot_index = ready_slots_.front();
        ready_slots_.pop_front();
      }

      auto& slot = slots_[slot_index];
      const bool wrote = WriteAll(ffmpeg_stdin_fd_, slot.bytes.data(), frame_bytes_);
      std::lock_guard<std::mutex> lock(mutex_);
      if (!wrote) {
        free_slots_.push_back(slot_index);
        ++backpressure_events_;
        SetFailureLocked("native_backpressure", "FFmpeg stdin write failed");
        ReleaseReadySlotsLocked();
        return;
      }
      if (completed_receipts_.size() >= kMaxCompletedReceipts) {
        free_slots_.push_back(slot_index);
        ++backpressure_events_;
        SetFailureLocked("native_backpressure", "native receipt queue was not drained");
        ReleaseReadySlotsLocked();
        return;
      }
      const uint64_t commit_ordinal = native_commits_++;
      completed_receipts_.push_back({slot.metadata, commit_ordinal, encoded_frames_++,
                                     std::move(slot.bgra_sha256), slot.service_time_ms});
      free_slots_.push_back(slot_index);
      condition_.notify_all();
    }
  }

  void SetFailureLocked(std::string code, std::string reason) {
    if (failure_code_.empty()) {
      failure_code_ = std::move(code);
      failure_reason_ = std::move(reason);
    }
    failed_ = true;
    condition_.notify_all();
  }

  void ReleaseQueuedLeasesLocked() {
    while (!queued_leases_.empty()) {
      FrameLease lease = queued_leases_.front();
      queued_leases_.pop_front();
      CFRelease(lease.surface);
      ++handles_released_;
      --active_leases_;
    }
  }

  void ReleaseReadySlotsLocked() {
    while (!ready_slots_.empty()) {
      free_slots_.push_back(ready_slots_.front());
      ready_slots_.pop_front();
    }
    condition_.notify_all();
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
    if (lifecycle_ != Lifecycle::kAborted && ffmpeg_exit_code_ != 0) {
      std::lock_guard<std::mutex> lock(mutex_);
      SetFailureLocked("native_encoder_exit_nonzero", "FFmpeg exited unsuccessfully");
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
  std::thread readback_worker_;
  std::thread writer_worker_;
  std::deque<FrameLease> queued_leases_;
  std::deque<FrameReceipt> completed_receipts_;
  bool readback_finished_ = false;
  Lifecycle lifecycle_ = Lifecycle::kActive;
  pid_t ffmpeg_pid_ = -1;
  int ffmpeg_stdin_fd_ = -1;
  bool started_ = false;
  bool failed_ = false;
  bool ffmpeg_waited_ = false;
  int ffmpeg_exit_code_ = std::numeric_limits<int>::min();
  std::string failure_code_;
  std::string failure_reason_;
  FrameMetadata previous_metadata_;
  bool has_previous_metadata_ = false;
  uint64_t handles_imported_ = 0;
  uint64_t handles_released_ = 0;
  uint64_t active_leases_ = 0;
  uint64_t peak_active_leases_ = 0;
  uint64_t delivery_frames_ = 0;
  uint64_t native_leases_accepted_ = 0;
  uint64_t native_commits_ = 0;
  uint64_t encoded_frames_ = 0;
  uint64_t lease_overflows_ = 0;
  uint64_t lease_admission_waits_ = 0;
  double lease_admission_wait_max_ms_ = 0;
  uint64_t backpressure_events_ = 0;
  uint64_t deadline_misses_ = 0;
  uint64_t source_ordinal_gaps_ = 0;
  uint64_t source_timestamp_regressions_ = 0;
  size_t max_queue_depth_ = 0;
  size_t max_ready_queue_depth_ = 0;
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

double Percentile(std::vector<double> values, double percentile) {
  if (values.empty()) return 0;
  std::sort(values.begin(), values.end());
  const size_t index = static_cast<size_t>(percentile * static_cast<double>(values.size() - 1));
  return values[index];
}

napi_value RecordingSession::Stats(napi_env env) const {
  std::lock_guard<std::mutex> lock(mutex_);
  napi_value stats;
  napi_create_object(env, &stats);
  SetNamedNumber(env, stats, "handlesImported", static_cast<double>(handles_imported_));
  SetNamedNumber(env, stats, "handlesReleased", static_cast<double>(handles_released_));
  SetNamedNumber(env, stats, "activeLeases", static_cast<double>(active_leases_));
  SetNamedNumber(env, stats, "peakActiveLeases", static_cast<double>(peak_active_leases_));
  SetNamedNumber(env, stats, "deliveryFrames", static_cast<double>(delivery_frames_));
  SetNamedNumber(env, stats, "nativeLeasesAccepted", static_cast<double>(native_leases_accepted_));
  SetNamedNumber(env, stats, "nativeCommits", static_cast<double>(native_commits_));
  SetNamedNumber(env, stats, "encodedFrames", static_cast<double>(encoded_frames_));
  SetNamedNumber(env, stats, "leaseOverflows", static_cast<double>(lease_overflows_));
  SetNamedNumber(env, stats, "leaseAdmissionWaits",
                 static_cast<double>(lease_admission_waits_));
  SetNamedNumber(env, stats, "leaseAdmissionWaitMaxMs", lease_admission_wait_max_ms_);
  SetNamedNumber(env, stats, "backpressureEvents", static_cast<double>(backpressure_events_));
  SetNamedNumber(env, stats, "deadlineMisses", static_cast<double>(deadline_misses_));
  SetNamedNumber(env, stats, "sourceOrdinalGaps", static_cast<double>(source_ordinal_gaps_));
  SetNamedNumber(env, stats, "sourceTimestampRegressions",
                 static_cast<double>(source_timestamp_regressions_));
  SetNamedNumber(env, stats, "maxQueueDepth", static_cast<double>(max_queue_depth_));
  SetNamedNumber(env, stats, "maxReadyQueueDepth",
                 static_cast<double>(max_ready_queue_depth_));
  SetNamedNumber(env, stats, "boundedPoolBytes",
                 static_cast<double>(frame_bytes_ * kFramePoolSlots));
  SetNamedNumber(env, stats, "serviceTimeP95Ms", Percentile(service_times_ms_, 0.95));
  SetNamedNumber(env, stats, "serviceTimeP99Ms", Percentile(service_times_ms_, 0.99));
  SetNamedNumber(env, stats, "serviceTimeMaxMs", Percentile(service_times_ms_, 1));
  SetNamedNumber(env, stats, "ffmpegExitCode", static_cast<double>(ffmpeg_exit_code_));
  SetNamedBoolean(env, stats, "failed", failed_);
  SetNamedString(env, stats, "failureCode", failure_code_);
  SetNamedString(env, stats, "failureReason", failure_reason_);
  return stats;
}

napi_value ThrowTypeError(napi_env env, const char* message) {
  napi_throw_type_error(env, nullptr, message);
  return nullptr;
}

napi_value ThrowSessionError(napi_env env, const RecordingSession* session) {
  const std::string message = session->failure_code() + ":" + session->failure_reason();
  napi_throw_error(env, session->failure_code().c_str(), message.c_str());
  return nullptr;
}

bool NamedValue(napi_env env, napi_value object, const char* name, napi_value* value) {
  bool has_property = false;
  return napi_has_named_property(env, object, name, &has_property) == napi_ok && has_property &&
         napi_get_named_property(env, object, name, value) == napi_ok;
}

bool NamedNumber(napi_env env, napi_value object, const char* name, double* value) {
  napi_value property;
  return NamedValue(env, object, name, &property) &&
         napi_get_value_double(env, property, value) == napi_ok;
}

bool NamedString(napi_env env, napi_value object, const char* name, std::string* value) {
  napi_value property;
  if (!NamedValue(env, object, name, &property)) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, property, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char> bytes(length + 1);
  if (napi_get_value_string_utf8(env, property, bytes.data(), bytes.size(), &length) != napi_ok)
    return false;
  value->assign(bytes.data(), length);
  return true;
}

bool RequiredUnsigned(napi_env env, napi_value object, const char* name, uint64_t* output) {
  double value = 0;
  if (!NamedNumber(env, object, name, &value) || value < 0 || std::floor(value) != value ||
      value > 9007199254740991.0) {
    return false;
  }
  *output = static_cast<uint64_t>(value);
  return true;
}

bool RequiredSigned(napi_env env, napi_value object, const char* name, int64_t* output) {
  double value = 0;
  if (!NamedNumber(env, object, name, &value) || value < 0 || std::floor(value) != value ||
      value > 9007199254740991.0) {
    return false;
  }
  *output = static_cast<int64_t>(value);
  return true;
}

RecordingSession* UnwrapSession(napi_env env, napi_callback_info info, napi_value* argument = nullptr) {
  size_t argc = argument == nullptr ? 0 : 1;
  napi_value this_value;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, &this_value, nullptr) != napi_ok) return nullptr;
  RecordingSession* session = nullptr;
  if (napi_unwrap(env, this_value, reinterpret_cast<void**>(&session)) != napi_ok) return nullptr;
  if (argument != nullptr && argc == 1) *argument = args[0];
  return session;
}

void FinalizeSession(napi_env env, void* data, void* hint) {
  delete static_cast<RecordingSession*>(data);
}

napi_value Submit(napi_env env, napi_callback_info info) {
  napi_value input;
  RecordingSession* session = UnwrapSession(env, info, &input);
  if (session == nullptr) return ThrowTypeError(env, "invalid Recording V3 native session");
  napi_value handle_value;
  if (!NamedValue(env, input, "ioSurface", &handle_value)) {
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

  FrameMetadata metadata;
  if (!RequiredUnsigned(env, input, "sourceEpoch", &metadata.source_epoch) ||
      !RequiredUnsigned(env, input, "activeSegment", &metadata.active_segment) ||
      !RequiredUnsigned(env, input, "sourceFrameCount", &metadata.source_frame_count) ||
      !RequiredSigned(env, input, "sourceTimestampUs", &metadata.source_timestamp_us) ||
      !RequiredSigned(env, input, "activeTimePtsUs", &metadata.active_time_pts_us) ||
      !RequiredUnsigned(env, input, "deliveryOrdinal", &metadata.delivery_ordinal) ||
      !RequiredUnsigned(env, input, "nativeLeaseOrdinal", &metadata.native_lease_ordinal)) {
    return ThrowTypeError(env, "Recording V3 frame metadata must contain safe non-negative integers");
  }
  uint64_t lease_ordinal = 0;
  if (!session->Submit(reinterpret_cast<IOSurfaceRef>(pointer), metadata, &lease_ordinal)) {
    return ThrowSessionError(env, session);
  }
  napi_value receipt;
  napi_create_object(env, &receipt);
  SetNamedNumber(env, receipt, "nativeLeaseOrdinal", static_cast<double>(lease_ordinal));
  return receipt;
}

napi_value Pause(napi_env env, napi_callback_info info) {
  RecordingSession* session = UnwrapSession(env, info);
  if (session == nullptr) return ThrowTypeError(env, "invalid Recording V3 native session");
  if (!session->Pause()) return ThrowSessionError(env, session);
  return session->Stats(env);
}

napi_value Resume(napi_env env, napi_callback_info info) {
  napi_value input;
  RecordingSession* session = UnwrapSession(env, info, &input);
  uint64_t source_epoch = 0;
  uint64_t active_segment = 0;
  if (session == nullptr || !RequiredUnsigned(env, input, "sourceEpoch", &source_epoch) ||
      !RequiredUnsigned(env, input, "activeSegment", &active_segment)) {
    return ThrowTypeError(env, "resume requires sourceEpoch and activeSegment");
  }
  if (!session->Resume(source_epoch, active_segment)) return ThrowSessionError(env, session);
  return session->Stats(env);
}

napi_value CloseEpoch(napi_env env, napi_callback_info info) {
  napi_value input;
  RecordingSession* session = UnwrapSession(env, info, &input);
  uint64_t source_epoch = 0;
  uint64_t active_segment = 0;
  if (session == nullptr || !RequiredUnsigned(env, input, "sourceEpoch", &source_epoch) ||
      !RequiredUnsigned(env, input, "activeSegment", &active_segment)) {
    return ThrowTypeError(env, "closeEpoch requires sourceEpoch and activeSegment");
  }
  if (!session->CloseEpoch(source_epoch, active_segment)) return ThrowSessionError(env, session);
  return session->Stats(env);
}

napi_value ReceiptValue(napi_env env, const FrameReceipt& receipt) {
  napi_value value;
  napi_create_object(env, &value);
  SetNamedNumber(env, value, "sourceEpoch", static_cast<double>(receipt.metadata.source_epoch));
  SetNamedNumber(env, value, "activeSegment", static_cast<double>(receipt.metadata.active_segment));
  SetNamedNumber(env, value, "sourceFrameCount",
                 static_cast<double>(receipt.metadata.source_frame_count));
  SetNamedNumber(env, value, "sourceTimestampUs",
                 static_cast<double>(receipt.metadata.source_timestamp_us));
  SetNamedNumber(env, value, "activeTimePtsUs",
                 static_cast<double>(receipt.metadata.active_time_pts_us));
  SetNamedNumber(env, value, "deliveryOrdinal",
                 static_cast<double>(receipt.metadata.delivery_ordinal));
  SetNamedNumber(env, value, "nativeLeaseOrdinal",
                 static_cast<double>(receipt.metadata.native_lease_ordinal));
  SetNamedNumber(env, value, "nativeCommitOrdinal",
                 static_cast<double>(receipt.native_commit_ordinal));
  SetNamedNumber(env, value, "encodedOrdinal", static_cast<double>(receipt.encoded_ordinal));
  SetNamedString(env, value, "bgraSha256", receipt.bgra_sha256);
  SetNamedNumber(env, value, "serviceTimeMs", receipt.service_time_ms);
  return value;
}

napi_value DrainReceipts(napi_env env, napi_callback_info info) {
  RecordingSession* session = UnwrapSession(env, info);
  if (session == nullptr) return ThrowTypeError(env, "invalid Recording V3 native session");
  const std::vector<FrameReceipt> receipts = session->DrainReceipts();
  napi_value output;
  napi_create_array_with_length(env, receipts.size(), &output);
  for (size_t index = 0; index < receipts.size(); ++index) {
    napi_set_element(env, output, index, ReceiptValue(env, receipts[index]));
  }
  return output;
}

napi_value TerminalResult(napi_env env, RecordingSession* session) {
  napi_value output;
  napi_create_object(env, &output);
  napi_set_named_property(env, output, "stats", session->Stats(env));
  const std::vector<FrameReceipt> receipts = session->DrainReceipts();
  napi_value receipt_values;
  napi_create_array_with_length(env, receipts.size(), &receipt_values);
  for (size_t index = 0; index < receipts.size(); ++index) {
    napi_set_element(env, receipt_values, index, ReceiptValue(env, receipts[index]));
  }
  napi_set_named_property(env, output, "receipts", receipt_values);
  return output;
}

napi_value Stop(napi_env env, napi_callback_info info) {
  RecordingSession* session = UnwrapSession(env, info);
  if (session == nullptr) return ThrowTypeError(env, "invalid Recording V3 native session");
  session->Stop();
  return TerminalResult(env, session);
}

napi_value Abort(napi_env env, napi_callback_info info) {
  RecordingSession* session = UnwrapSession(env, info);
  if (session == nullptr) return ThrowTypeError(env, "invalid Recording V3 native session");
  session->Abort();
  return TerminalResult(env, session);
}

napi_value GetStats(napi_env env, napi_callback_info info) {
  RecordingSession* session = UnwrapSession(env, info);
  if (session == nullptr) return ThrowTypeError(env, "invalid Recording V3 native session");
  return session->Stats(env);
}

napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1) {
    return ThrowTypeError(env, "Recording V3 start options are required");
  }
  double width = 0;
  double height = 0;
  std::string ffmpeg_path;
  std::string output_path;
  if (!NamedNumber(env, args[0], "width", &width) || !NamedNumber(env, args[0], "height", &height) ||
      !std::isfinite(width) || !std::isfinite(height) || width != std::floor(width) ||
      height != std::floor(height) || width <= 0 || height <= 0 || width > kMaximumWidth ||
      height > kMaximumHeight) {
    return ThrowTypeError(env, "Recording V3 dimensions must be positive integers within 1920x1080");
  }
  const auto session_width = static_cast<uint32_t>(width);
  const auto session_height = static_cast<uint32_t>(height);
  size_t frame_bytes = 0;
  if (!FrameByteCount(session_width, session_height, &frame_bytes)) {
    return ThrowTypeError(env, "Recording V3 dimensions exceed the 2073600 pixel boundary");
  }
  if (!NamedString(env, args[0], "ffmpegPath", &ffmpeg_path) || ffmpeg_path.empty() ||
      !NamedString(env, args[0], "outputPath", &output_path) || output_path.empty()) {
    return ThrowTypeError(env, "ffmpegPath and outputPath are required");
  }
  auto* session = new RecordingSession(session_width, session_height, frame_bytes,
                                       std::move(ffmpeg_path), std::move(output_path));
  if (!session->started()) {
    napi_value result = ThrowSessionError(env, session);
    delete session;
    return result;
  }
  napi_value object;
  napi_create_object(env, &object);
  if (napi_wrap(env, object, session, FinalizeSession, nullptr, nullptr) != napi_ok) {
    delete session;
    return ThrowTypeError(env, "failed to wrap Recording V3 native session");
  }
  const napi_property_descriptor methods[] = {
      {"submit", nullptr, Submit, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"pause", nullptr, Pause, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"resume", nullptr, Resume, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"closeEpoch", nullptr, CloseEpoch, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"drainReceipts", nullptr, DrainReceipts, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"abort", nullptr, Abort, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getStats", nullptr, GetStats, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, object, sizeof(methods) / sizeof(methods[0]), methods);
  return object;
}

napi_value Probe(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_create_object(env, &result);
  SetNamedNumber(env, result, "protocolVersion", kProtocolVersion);
  SetNamedString(env, result, "protocolHash", kProtocolHash);
  SetNamedBoolean(env, result, "ioSurface", true);
  SetNamedBoolean(env, result, "nativeFfv1", true);
  SetNamedNumber(env, result, "maxQueuedLeases", kMaxQueuedLeases);
  SetNamedNumber(env, result, "maxCompletedReceipts", kMaxCompletedReceipts);
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  signal(SIGPIPE, SIG_IGN);
  const napi_property_descriptor methods[] = {
      {"probe", nullptr, Probe, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  SetNamedNumber(env, exports, "protocolVersion", kProtocolVersion);
  SetNamedString(env, exports, "protocolHash", kProtocolHash);
  return exports;
}

}  // namespace

NAPI_MODULE(storycapture_recording_v3, Init)
