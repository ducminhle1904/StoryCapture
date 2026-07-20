import CryptoKit
import Foundation

public struct DisplayIdentityCandidate: Equatable, Sendable {
    public let displayID: UInt32
    public let logicalWidth: Int
    public let logicalHeight: Int
    public let physicalWidth: Int
    public let physicalHeight: Int
    public let originX: Int
    public let originY: Int

    public init(
        displayID: UInt32,
        logicalWidth: Int,
        logicalHeight: Int,
        physicalWidth: Int,
        physicalHeight: Int,
        originX: Int,
        originY: Int
    ) {
        self.displayID = displayID
        self.logicalWidth = logicalWidth
        self.logicalHeight = logicalHeight
        self.physicalWidth = physicalWidth
        self.physicalHeight = physicalHeight
        self.originX = originX
        self.originY = originY
    }
}

public struct WindowIdentityCandidate: Equatable, Sendable {
    public let windowID: UInt32
    public let ownerPID: Int32
    public let ownerBundleID: String
    public let title: String
    public let width: Int
    public let height: Int

    public init(
        windowID: UInt32,
        ownerPID: Int32,
        ownerBundleID: String,
        title: String,
        width: Int,
        height: Int
    ) {
        self.windowID = windowID
        self.ownerPID = ownerPID
        self.ownerBundleID = ownerBundleID
        self.title = title
        self.width = width
        self.height = height
    }
}

public struct ResolvedTargetIdentity: Equatable, Sendable {
    public let fingerprint: String
    public let logicalWidth: Int
    public let logicalHeight: Int
    public let physicalWidth: Int
    public let physicalHeight: Int

    public init(
        fingerprint: String,
        logicalWidth: Int,
        logicalHeight: Int,
        physicalWidth: Int,
        physicalHeight: Int
    ) {
        self.fingerprint = fingerprint
        self.logicalWidth = logicalWidth
        self.logicalHeight = logicalHeight
        self.physicalWidth = physicalWidth
        self.physicalHeight = physicalHeight
    }
}

public enum TargetIdentityResolver {
    public static func display(
        target: HelperTarget,
        candidates: [DisplayIdentityCandidate]
    ) throws -> ResolvedTargetIdentity {
        guard target.kind == .display, let displayID = target.displayID else {
            throw HelperFailureCode.contractMismatch
        }
        let matches = candidates.filter { $0.displayID == displayID }
        guard !matches.isEmpty else { throw HelperFailureCode.targetMissing }
        guard matches.count == 1, let match = matches.first else {
            throw HelperFailureCode.targetAmbiguous
        }
        let fingerprint = digest(
            "display:\(match.displayID):\(match.logicalWidth)x\(match.logicalHeight):\(match.physicalWidth)x\(match.physicalHeight)@\(match.originX),\(match.originY)"
        )
        try validateExpected(target.expectedIdentity, actual: fingerprint)
        return ResolvedTargetIdentity(
            fingerprint: fingerprint,
            logicalWidth: match.logicalWidth,
            logicalHeight: match.logicalHeight,
            physicalWidth: match.physicalWidth,
            physicalHeight: match.physicalHeight
        )
    }

    public static func window(
        target: HelperTarget,
        candidates: [WindowIdentityCandidate],
        scaleFactor: Double
    ) throws -> ResolvedTargetIdentity {
        guard target.kind == .window,
              let windowID = target.windowID,
              let ownerPID = target.ownerPID,
              let ownerBundleID = target.ownerBundleID,
              !ownerBundleID.isEmpty else {
            throw HelperFailureCode.contractMismatch
        }
        let matches = candidates.filter {
            $0.windowID == windowID &&
                $0.ownerPID == ownerPID &&
                $0.ownerBundleID == ownerBundleID
        }
        guard !matches.isEmpty else { throw HelperFailureCode.targetMissing }
        guard matches.count == 1, let match = matches.first else {
            throw HelperFailureCode.targetAmbiguous
        }
        let fingerprint = digest(
            "window:\(match.windowID):\(match.ownerPID):\(match.ownerBundleID):\(match.title):\(match.width)x\(match.height)"
        )
        try validateExpected(target.expectedIdentity, actual: fingerprint)
        return ResolvedTargetIdentity(
            fingerprint: fingerprint,
            logicalWidth: match.width,
            logicalHeight: match.height,
            physicalWidth: Int((Double(match.width) * scaleFactor).rounded()),
            physicalHeight: Int((Double(match.height) * scaleFactor).rounded())
        )
    }

    public static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func validateExpected(_ expected: String?, actual: String) throws {
        if let expected, expected != actual {
            throw HelperFailureCode.targetChanged
        }
    }
}
