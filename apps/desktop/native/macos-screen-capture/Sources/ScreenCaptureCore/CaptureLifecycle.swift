import Foundation

public enum CaptureLifecycleState: String, Equatable, Sendable {
    case idle
    case running
    case paused
    case stopped
    case failed
}

public struct CaptureLifecycle: Equatable, Sendable {
    public private(set) var state: CaptureLifecycleState = .idle

    public init() {}

    public mutating func start() throws {
        guard state == .idle || state == .stopped else {
            throw HelperFailureCode.contractMismatch
        }
        state = .running
    }

    public mutating func pause() throws {
        guard state == .running else { throw HelperFailureCode.contractMismatch }
        state = .paused
    }

    public mutating func resume() throws {
        guard state == .paused else { throw HelperFailureCode.contractMismatch }
        state = .running
    }

    public mutating func stop() throws {
        guard state == .running || state == .paused else {
            throw HelperFailureCode.contractMismatch
        }
        state = .stopped
    }

    public mutating func fail() {
        state = .failed
    }
}
