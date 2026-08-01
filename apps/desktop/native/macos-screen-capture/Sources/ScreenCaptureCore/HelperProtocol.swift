import CoreMedia
import Foundation

public let recordingV4ProtocolVersion = 4
public let helperBackendID = "screen-capture-kit"
public let recordingV4BackendVersion = "4.0.0"

public enum HelperFailureCode: String, Codable, Error, Sendable {
    case backendUnavailable = "backend_unavailable"
    case helperUnavailable = "helper_unavailable"
    case contractMismatch = "contract_mismatch"
    case permissionDenied = "permission_denied"
    case sourceRateMismatch = "source_rate_mismatch"
    case submittedFrameDropped = "submitted_frame_dropped"
    case encoderBackpressure = "encoder_backpressure"
    case encoderRejectedFrame = "encoder_rejected_frame"
    case encoderWarmupFailed = "encoder_warmup_failed"
    case hardwareEncoderUnavailable = "hardware_encoder_unavailable"
    case surfaceNot1080p = "surface_not_1080p"
    case audioDeviceUnavailable = "audio_device_unavailable"
    case audioFormatInvalid = "audio_format_invalid"
    case audioContinuityFailed = "audio_continuity_failed"
    case frameSlotMissing = "frame_slot_missing"
    case frameLedgerInvalid = "frame_ledger_invalid"
    case outputFrameCountMismatch = "output_frame_count_mismatch"
    case outputPTSInvalid = "output_pts_invalid"
    case artifactFinalizeFailed = "artifact_finalize_failed"
    case artifactProbeFailed = "artifact_probe_failed"
    case artifactDecodeFailed = "artifact_decode_failed"
    case targetAmbiguous = "target_ambiguous"
    case targetChanged = "target_changed"
    case targetLost = "target_lost"
    case targetMissing = "target_missing"
}

public struct HelperTarget: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case display
        case window
    }

    public let kind: Kind
    public let displayID: UInt32?
    public let windowID: UInt32?
    public let ownerPID: Int32?
    public let ownerBundleID: String?
    public let expectedIdentity: String?
    public let mediaSourceID: String?

    public init(
        kind: Kind,
        displayID: UInt32? = nil,
        windowID: UInt32? = nil,
        ownerPID: Int32? = nil,
        ownerBundleID: String? = nil,
        expectedIdentity: String? = nil,
        mediaSourceID: String? = nil
    ) {
        self.kind = kind
        self.displayID = displayID
        self.windowID = windowID
        self.ownerPID = ownerPID
        self.ownerBundleID = ownerBundleID
        self.expectedIdentity = expectedIdentity
        self.mediaSourceID = mediaSourceID
    }
}

public enum RecordingV4AudioRole: String, Codable, CaseIterable, Sendable {
    case microphone
    case system
}

public struct RecordingV4EncoderEnvelope: Codable, Equatable, Sendable {
    public let source: String
    public let encoderID: String
    public let minimumBitrateBPS: Int
    public let targetBitrateBPS: Int
    public let maximumBitrateBPS: Int
    public let safetyHeadroomRatio: Double

    enum CodingKeys: String, CodingKey {
        case source
        case encoderID = "encoder_id"
        case minimumBitrateBPS = "minimum_bitrate_bps"
        case targetBitrateBPS = "target_bitrate_bps"
        case maximumBitrateBPS = "maximum_bitrate_bps"
        case safetyHeadroomRatio = "safety_headroom_ratio"
    }

    public init(
        source: String,
        encoderID: String,
        minimumBitrateBPS: Int,
        targetBitrateBPS: Int,
        maximumBitrateBPS: Int,
        safetyHeadroomRatio: Double
    ) {
        self.source = source
        self.encoderID = encoderID
        self.minimumBitrateBPS = minimumBitrateBPS
        self.targetBitrateBPS = targetBitrateBPS
        self.maximumBitrateBPS = maximumBitrateBPS
        self.safetyHeadroomRatio = safetyHeadroomRatio
    }

    public func validate() throws {
        guard source == "built_in_profile",
              encoderID == "videotoolbox-h264",
              minimumBitrateBPS > 0,
              minimumBitrateBPS <= targetBitrateBPS,
              targetBitrateBPS <= maximumBitrateBPS,
              safetyHeadroomRatio > 0,
              safetyHeadroomRatio < 1 else {
            throw HelperFailureCode.contractMismatch
        }
    }
}

public struct HelperCommandPayload: Codable, Equatable, Sendable {
    public let target: HelperTarget?
    public let outputWidth: Int?
    public let outputHeight: Int?
    public let expectedLogicalWidth: Int?
    public let expectedLogicalHeight: Int?
    public let expectedPhysicalWidth: Int?
    public let expectedPhysicalHeight: Int?
    public let showsCursor: Bool?
    public let artifactPath: String?
    public let fpsNumerator: Int?
    public let fpsDenominator: Int?
    public let requestedAudioRoles: [RecordingV4AudioRole]?
    public let encoderEnvelope: RecordingV4EncoderEnvelope?

    public init(
        target: HelperTarget? = nil,
        outputWidth: Int? = nil,
        outputHeight: Int? = nil,
        expectedLogicalWidth: Int? = nil,
        expectedLogicalHeight: Int? = nil,
        expectedPhysicalWidth: Int? = nil,
        expectedPhysicalHeight: Int? = nil,
        showsCursor: Bool? = nil,
        artifactPath: String? = nil,
        fpsNumerator: Int? = nil,
        fpsDenominator: Int? = nil,
        requestedAudioRoles: [RecordingV4AudioRole]? = nil,
        encoderEnvelope: RecordingV4EncoderEnvelope? = nil
    ) {
        self.target = target
        self.outputWidth = outputWidth
        self.outputHeight = outputHeight
        self.expectedLogicalWidth = expectedLogicalWidth
        self.expectedLogicalHeight = expectedLogicalHeight
        self.expectedPhysicalWidth = expectedPhysicalWidth
        self.expectedPhysicalHeight = expectedPhysicalHeight
        self.showsCursor = showsCursor
        self.artifactPath = artifactPath
        self.fpsNumerator = fpsNumerator
        self.fpsDenominator = fpsDenominator
        self.requestedAudioRoles = requestedAudioRoles
        self.encoderEnvelope = encoderEnvelope
    }
}

public struct HelperCommand: Codable, Equatable, Sendable {
    public enum Name: String, Codable, Sendable {
        case hello
        case warmup
        case start
        case pause
        case resume
        case stop
        case cancel
        case shutdown
    }

    public let version: Int
    public let requestID: String
    public let command: Name
    public let sessionID: String?
    public let payload: HelperCommandPayload?

    enum CodingKeys: String, CodingKey {
        case version
        case requestID = "request_id"
        case command
        case sessionID = "session_id"
        case payload
    }

    public init(
        version: Int = recordingV4ProtocolVersion,
        requestID: String,
        command: Name,
        sessionID: String? = nil,
        payload: HelperCommandPayload? = nil
    ) {
        self.version = version
        self.requestID = requestID
        self.command = command
        self.sessionID = sessionID
        self.payload = payload
    }
}

public func monotonicMicroseconds(_ time: CMTime) -> UInt64? {
    guard time.isValid, time.isNumeric else { return nil }
    let seconds = CMTimeGetSeconds(time)
    guard seconds.isFinite, seconds >= 0, seconds <= Double(UInt64.max) / 1_000_000 else {
        return nil
    }
    return UInt64((seconds * 1_000_000).rounded())
}

public func windowIDFromMediaSourceID(_ value: String) -> UInt32? {
    let fields = value.split(separator: ":", omittingEmptySubsequences: false)
    guard fields.count >= 2,
          fields[0] == "window",
          let id = UInt32(fields[1]),
          id > 0 else {
        return nil
    }
    return id
}
