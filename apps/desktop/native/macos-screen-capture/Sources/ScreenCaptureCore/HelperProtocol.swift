import CoreMedia
import Foundation

public let helperProtocolVersion = 2
public let helperBackendID = "screen-capture-kit"
public let helperBackendVersion = "2.0.0"

public enum HelperFailureCode: String, Codable, Error, Sendable {
    case backendUnavailable = "backend_unavailable"
    case contractMismatch = "contract_mismatch"
    case permissionDenied = "permission_denied"
    case sourceRateMismatch = "source_rate_mismatch"
    case submittedFrameDropped = "submitted_frame_dropped"
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

    public init(
        kind: Kind,
        displayID: UInt32? = nil,
        windowID: UInt32? = nil,
        ownerPID: Int32? = nil,
        ownerBundleID: String? = nil,
        expectedIdentity: String? = nil
    ) {
        self.kind = kind
        self.displayID = displayID
        self.windowID = windowID
        self.ownerPID = ownerPID
        self.ownerBundleID = ownerBundleID
        self.expectedIdentity = expectedIdentity
    }
}

public enum DynamicSizePolicy: String, Codable, Sendable {
    case failOnChange = "fail_on_change"
    case scaleToContract = "scale_to_contract"
}

public struct HelperCommandPayload: Codable, Equatable, Sendable {
    public let target: HelperTarget?
    public let outputWidth: Int?
    public let outputHeight: Int?
    public let expectedLogicalWidth: Int?
    public let expectedLogicalHeight: Int?
    public let showsCursor: Bool?
    public let dynamicSizePolicy: DynamicSizePolicy?
    public let capturesSystemAudio: Bool?
    public let probeDurationMS: Int?

    public init(
        target: HelperTarget? = nil,
        outputWidth: Int? = nil,
        outputHeight: Int? = nil,
        expectedLogicalWidth: Int? = nil,
        expectedLogicalHeight: Int? = nil,
        showsCursor: Bool? = nil,
        dynamicSizePolicy: DynamicSizePolicy? = nil,
        capturesSystemAudio: Bool? = nil,
        probeDurationMS: Int? = nil
    ) {
        self.target = target
        self.outputWidth = outputWidth
        self.outputHeight = outputHeight
        self.expectedLogicalWidth = expectedLogicalWidth
        self.expectedLogicalHeight = expectedLogicalHeight
        self.showsCursor = showsCursor
        self.dynamicSizePolicy = dynamicSizePolicy
        self.capturesSystemAudio = capturesSystemAudio
        self.probeDurationMS = probeDurationMS
    }
}

public struct HelperCommand: Codable, Equatable, Sendable {
    public enum Name: String, Codable, Sendable {
        case hello
        case probe
        case start
        case pause
        case resume
        case stop
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
        version: Int = helperProtocolVersion,
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

public enum NativePacketKind: UInt32, Sendable {
    case videoBGRA = 1
    case systemAudioLPCM = 2
}

public struct NativePacketHeader: Equatable, Sendable {
    public static let byteCount = 64
    public static let magic = Array("SCFRM2\0\0".utf8)

    public let kind: NativePacketKind
    public let sequence: UInt64
    public let nativePTSUS: UInt64
    public let width: UInt32
    public let height: UInt32
    public let stride: UInt32
    public let format: UInt32
    public let payloadBytes: UInt64
    public let flags: UInt64

    public init(
        kind: NativePacketKind,
        sequence: UInt64,
        nativePTSUS: UInt64,
        width: UInt32,
        height: UInt32,
        stride: UInt32,
        format: UInt32,
        payloadBytes: UInt64,
        flags: UInt64 = 0
    ) {
        self.kind = kind
        self.sequence = sequence
        self.nativePTSUS = nativePTSUS
        self.width = width
        self.height = height
        self.stride = stride
        self.format = format
        self.payloadBytes = payloadBytes
        self.flags = flags
    }

    public func encode() -> Data {
        var data = Data(Self.magic)
        data.appendLittleEndian(kind.rawValue)
        data.appendLittleEndian(UInt32(Self.byteCount))
        data.appendLittleEndian(sequence)
        data.appendLittleEndian(nativePTSUS)
        data.appendLittleEndian(width)
        data.appendLittleEndian(height)
        data.appendLittleEndian(stride)
        data.appendLittleEndian(format)
        data.appendLittleEndian(payloadBytes)
        data.appendLittleEndian(flags)
        precondition(data.count == Self.byteCount)
        return data
    }
}

public extension Data {
    mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        var encoded = value.littleEndian
        Swift.withUnsafeBytes(of: &encoded) { append(contentsOf: $0) }
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
