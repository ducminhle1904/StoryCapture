import Foundation

let spikeProtocolVersion = 1
let spikeProtocolMaximumBytes = 64 * 1024

enum SpikeTransport: String, Codable {
    case hostFrames = "host_frames"
    case backendSegment = "backend_segment"
}

enum SpikeTargetKind: String, Codable {
    case display
    case displayRegion = "display_region"
    case window
}

struct SpikeSize: Codable, Equatable {
    let width: Int
    let height: Int
}

struct SpikeTarget: Codable {
    let kind: SpikeTargetKind
    let nativeID: UInt32
    let title: String?
    let ownerPID: Int32?
    let ownerBundleID: String?
    let sourceSize: SpikeSize
    let scaleFactor: Double?

    enum CodingKeys: String, CodingKey {
        case kind
        case nativeID = "native_id"
        case title
        case ownerPID = "owner_pid"
        case ownerBundleID = "owner_bundle_id"
        case sourceSize = "source_size"
        case scaleFactor = "scale_factor"
    }
}

struct SpikeAudioMetrics: Codable {
    let requested: Bool
    let bufferCount: Int
    let sampleCount: Int
    let firstPTSNS: Int64?
    let lastPTSNS: Int64?
    let nonMonotonicPTS: Int
    let zeroValuedBufferCount: Int
    let sampleRate: Double?
    let channelCount: UInt32?
    let firstSampleDelayMS: Double?
    let outputPath: String?
    let outputBytes: Int64?
    let writerStatus: String

    enum CodingKeys: String, CodingKey {
        case requested
        case bufferCount = "buffer_count"
        case sampleCount = "sample_count"
        case firstPTSNS = "first_pts_ns"
        case lastPTSNS = "last_pts_ns"
        case nonMonotonicPTS = "non_monotonic_pts"
        case zeroValuedBufferCount = "zero_valued_buffer_count"
        case sampleRate = "sample_rate"
        case channelCount = "channel_count"
        case firstSampleDelayMS = "first_sample_delay_ms"
        case outputPath = "output_path"
        case outputBytes = "output_bytes"
        case writerStatus = "writer_status"
    }
}

struct SpikeResult: Codable {
    let fixtureID: String
    let target: SpikeTarget?
    let targetKind: SpikeTargetKind
    let transport: SpikeTransport
    let requestedSize: SpikeSize
    let requestedFPS: Int
    let durationMS: Int
    let cursorIncluded: Bool
    let permissionPreflightGranted: Bool
    let permissionRequestAttempted: Bool
    let frameCount: Int
    let firstNativePTSNS: Int64?
    let lastNativePTSNS: Int64?
    let firstFrameDelayMS: Double?
    let nonMonotonicPTS: Int
    let droppedOrMissingFrames: Int
    let maxFrameGapMS: Double
    let formatChangeCount: Int
    let observedFormats: [String]
    let frameStatusCounts: [String: Int]
    let audio: SpikeAudioMetrics
    let backendSegmentPath: String?
    let backendSegmentBytes: Int64?
    let recordingOutputStatus: String
    let terminalReason: String?
    let startedUptimeNS: UInt64
    let endedUptimeNS: UInt64
    let osVersion: String
    let hardware: String
    let exactCommand: [String]

    enum CodingKeys: String, CodingKey {
        case fixtureID = "fixture_id"
        case target
        case targetKind = "target_kind"
        case transport
        case requestedSize = "requested_size"
        case requestedFPS = "requested_fps"
        case durationMS = "duration_ms"
        case cursorIncluded = "cursor_included"
        case permissionPreflightGranted = "permission_preflight_granted"
        case permissionRequestAttempted = "permission_request_attempted"
        case frameCount = "frame_count"
        case firstNativePTSNS = "first_native_pts_ns"
        case lastNativePTSNS = "last_native_pts_ns"
        case firstFrameDelayMS = "first_frame_delay_ms"
        case nonMonotonicPTS = "non_monotonic_pts"
        case droppedOrMissingFrames = "dropped_or_missing_frames"
        case maxFrameGapMS = "max_frame_gap_ms"
        case formatChangeCount = "format_change_count"
        case observedFormats = "observed_formats"
        case frameStatusCounts = "frame_status_counts"
        case audio
        case backendSegmentPath = "backend_segment_path"
        case backendSegmentBytes = "backend_segment_bytes"
        case recordingOutputStatus = "recording_output_status"
        case terminalReason = "terminal_reason"
        case startedUptimeNS = "started_uptime_ns"
        case endedUptimeNS = "ended_uptime_ns"
        case osVersion = "os_version"
        case hardware
        case exactCommand = "exact_command"
    }
}

struct SpikeFailure: Codable {
    let reason: String
    let detail: String
    let permissionPreflightGranted: Bool
    let permissionRequestAttempted: Bool
    let exactCommand: [String]

    enum CodingKeys: String, CodingKey {
        case reason
        case detail
        case permissionPreflightGranted = "permission_preflight_granted"
        case permissionRequestAttempted = "permission_request_attempted"
        case exactCommand = "exact_command"
    }
}

private struct SpikeEnvelope<Payload: Encodable>: Encodable {
    let version: Int
    let type: String
    let payload: Payload
}

func spikeJSONData<T: Encodable>(type: String, payload: T) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(
        SpikeEnvelope(version: spikeProtocolVersion, type: type, payload: payload)
    )
    guard data.count <= spikeProtocolMaximumBytes else {
        throw NSError(
            domain: "StoryCaptureNativeSpikeProtocol",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "protocol message exceeds 64 KiB"]
        )
    }
    return data
}

func emitSpikeMessage<T: Encodable>(type: String, payload: T) throws {
    var data = try spikeJSONData(type: type, payload: payload)
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}
