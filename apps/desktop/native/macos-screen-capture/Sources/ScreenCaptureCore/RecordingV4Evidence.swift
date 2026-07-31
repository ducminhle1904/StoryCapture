import Foundation

public let recordingV4FrameRate = 60

public struct RecordingV4SourceFrame: Equatable, Sendable {
    public let sequence: UInt64
    public let timestampUS: UInt64

    public init(sequence: UInt64, timestampUS: UInt64) {
        self.sequence = sequence
        self.timestampUS = timestampUS
    }
}

public struct RecordingV4FrameLedgerEntry: Equatable, Sendable {
    public let slot: UInt64
    public let ptsUS: UInt64
    public let sourceSequence: UInt64
    public let sourceTimestampUS: UInt64
    public let heldFromSlot: UInt64?
    public let submittedAtUS: UInt64
    public let acknowledgedAtUS: UInt64

    public var dictionary: [String: Any] {
        [
            "slot": slot,
            "pts_us": ptsUS,
            "source_sequence": sourceSequence,
            "source_timestamp_us": sourceTimestampUS,
            "held_from_slot": heldFromSlot ?? NSNull(),
            "submitted_at_us": submittedAtUS,
            "acknowledged_at_us": acknowledgedAtUS,
        ]
    }
}

public struct RecordingV4PauseInterval: Equatable, Sendable {
    public let startedMonotonicUS: UInt64
    public let endedMonotonicUS: UInt64

    public var dictionary: [String: Any] {
        [
            "started_monotonic_us": startedMonotonicUS,
            "ended_monotonic_us": endedMonotonicUS,
        ]
    }
}

public struct RecordingV4CadenceEvidence: Sendable {
    public let activeDurationUS: UInt64
    public let sourceUpdates: UInt64
    public let ringHighWaterMark: UInt64
    public let pauseIntervals: [RecordingV4PauseInterval]
    public let ledger: [RecordingV4FrameLedgerEntry]
    public let failureCodes: [HelperFailureCode]

    public var dictionary: [String: Any] {
        let heldFrames = ledger.reduce(into: 0) { count, entry in
            if entry.heldFromSlot != nil { count += 1 }
        }
        return [
            "version": recordingV4ProtocolVersion,
            "frame_rate": ["numerator": recordingV4FrameRate, "denominator": 1],
            "active_duration_us": activeDurationUS,
            "expected_output_frames": ledger.count,
            "output_frames": ledger.count,
            "source_updates": sourceUpdates,
            "held_frames": heldFrames,
            "submitted_frames": ledger.count,
            "acknowledged_frames": ledger.count,
            "ring_high_water_mark": ringHighWaterMark,
            "pause_intervals": pauseIntervals.map(\.dictionary),
            "ledger": ledger.map(\.dictionary),
            "verdict": failureCodes.isEmpty ? "passed" : "failed",
            "failure_codes": failureCodes.map(\.rawValue),
        ]
    }
}

public struct RecordingV4SlotScheduler: Sendable {
    private struct CurrentSource: Sendable {
        let frame: RecordingV4SourceFrame
        let originSlot: UInt64
    }

    private var startedAtUS: UInt64?
    private var pausedAtUS: UInt64?
    private var totalPausedUS: UInt64 = 0
    private var pauses: [RecordingV4PauseInterval] = []
    private var currentSource: CurrentSource?
    private var sourceUpdates: UInt64 = 0
    private var entries: [RecordingV4FrameLedgerEntry] = []
    private var terminalFailure: HelperFailureCode?

    public init() {}

    public static func ptsUS(for slot: UInt64) -> UInt64 {
        (slot * 1_000_000 + 30) / 60
    }

    public static func expectedFrameCount(activeDurationUS: UInt64) -> UInt64 {
        (activeDurationUS * 60 + 500_000) / 1_000_000
    }

    public func activeElapsedUS(at nowUS: UInt64) -> UInt64 {
        guard let startedAtUS else { return 0 }
        let openPause = pausedAtUS.map { nowUS >= $0 ? nowUS - $0 : 0 } ?? 0
        let wall = nowUS >= startedAtUS ? nowUS - startedAtUS : 0
        return wall >= totalPausedUS + openPause ? wall - totalPausedUS - openPause : 0
    }

    public mutating func ingest(
        _ frame: RecordingV4SourceFrame,
        at nowUS: UInt64,
        submit: (UInt64, Bool) throws -> (submittedAtUS: UInt64, acknowledgedAtUS: UInt64)
    ) throws {
        try checkTerminal()
        guard pausedAtUS == nil else { return }
        if startedAtUS == nil { startedAtUS = nowUS }
        if currentSource != nil {
            try emit(until: activeElapsedUS(at: nowUS), submit: submit)
        }
        let originSlot = UInt64(entries.count)
        currentSource = CurrentSource(frame: frame, originSlot: originSlot)
        if entries.isEmpty {
            try append(slot: 0, submit: submit)
        }
    }

    public mutating func advance(
        to nowUS: UInt64,
        submit: (UInt64, Bool) throws -> (submittedAtUS: UInt64, acknowledgedAtUS: UInt64)
    ) throws {
        try checkTerminal()
        guard pausedAtUS == nil else { return }
        try emit(until: activeElapsedUS(at: nowUS), submit: submit)
    }

    public mutating func pause(at nowUS: UInt64) throws {
        try checkTerminal()
        guard startedAtUS != nil, pausedAtUS == nil else { throw HelperFailureCode.contractMismatch }
        pausedAtUS = nowUS
    }

    public mutating func resume(at nowUS: UInt64) throws {
        try checkTerminal()
        guard let pauseStart = pausedAtUS, nowUS >= pauseStart else {
            throw HelperFailureCode.contractMismatch
        }
        totalPausedUS += nowUS - pauseStart
        pauses.append(.init(startedMonotonicUS: pauseStart, endedMonotonicUS: nowUS))
        pausedAtUS = nil
    }

    public mutating func finish(
        at nowUS: UInt64,
        submit: (UInt64, Bool) throws -> (submittedAtUS: UInt64, acknowledgedAtUS: UInt64)
    ) throws -> RecordingV4CadenceEvidence {
        try checkTerminal()
        guard startedAtUS != nil, currentSource != nil else { throw HelperFailureCode.frameSlotMissing }
        if let pauseStart = pausedAtUS {
            guard nowUS >= pauseStart else { throw HelperFailureCode.contractMismatch }
            totalPausedUS += nowUS - pauseStart
            pauses.append(.init(startedMonotonicUS: pauseStart, endedMonotonicUS: nowUS))
            pausedAtUS = nil
        }
        let activeDuration = activeElapsedUS(at: nowUS)
        let expected = Self.expectedFrameCount(activeDurationUS: activeDuration)
        while UInt64(entries.count) < expected {
            try append(slot: UInt64(entries.count), submit: submit)
        }
        guard UInt64(entries.count) == expected else { throw HelperFailureCode.frameLedgerInvalid }
        return RecordingV4CadenceEvidence(
            activeDurationUS: activeDuration,
            sourceUpdates: sourceUpdates,
            ringHighWaterMark: currentSource == nil ? 0 : 1,
            pauseIntervals: pauses,
            ledger: entries,
            failureCodes: []
        )
    }

    public mutating func fail(_ code: HelperFailureCode) {
        if terminalFailure == nil { terminalFailure = code }
    }

    private mutating func emit(
        until activeDurationUS: UInt64,
        submit: (UInt64, Bool) throws -> (submittedAtUS: UInt64, acknowledgedAtUS: UInt64)
    ) throws {
        let expected = Self.expectedFrameCount(activeDurationUS: activeDurationUS)
        while UInt64(entries.count) < expected {
            try append(slot: UInt64(entries.count), submit: submit)
        }
    }

    private mutating func append(
        slot: UInt64,
        submit: (UInt64, Bool) throws -> (submittedAtUS: UInt64, acknowledgedAtUS: UInt64)
    ) throws {
        guard slot == UInt64(entries.count), let currentSource else {
            terminalFailure = .frameSlotMissing
            throw HelperFailureCode.frameSlotMissing
        }
        do {
            let held = slot != currentSource.originSlot
            let timing = try submit(slot, held)
            guard timing.acknowledgedAtUS >= timing.submittedAtUS else {
                throw HelperFailureCode.frameLedgerInvalid
            }
            if !held { sourceUpdates += 1 }
            entries.append(.init(
                slot: slot,
                ptsUS: Self.ptsUS(for: slot),
                sourceSequence: currentSource.frame.sequence,
                sourceTimestampUS: currentSource.frame.timestampUS,
                heldFromSlot: held ? currentSource.originSlot : nil,
                submittedAtUS: timing.submittedAtUS,
                acknowledgedAtUS: timing.acknowledgedAtUS
            ))
        } catch {
            terminalFailure = (error as? HelperFailureCode) ?? .encoderRejectedFrame
            throw terminalFailure!
        }
    }

    private func checkTerminal() throws {
        if let terminalFailure { throw terminalFailure }
    }
}

public struct RecordingV4AudioLedgerEntry: Equatable, Sendable {
    public let sequence: UInt64
    public let ptsUS: UInt64
    public let durationUS: UInt64
    public let frames: UInt64

    public var dictionary: [String: Any] {
        ["sequence": sequence, "pts_us": ptsUS, "duration_us": durationUS, "frames": frames]
    }
}

public struct RecordingV4AudioEvidence: Sendable {
    public let role: RecordingV4AudioRole
    public let sampleRate: Int
    public let channels: Int
    public let codec: String
    public let startedOffsetUS: Int64
    public let durationUS: UInt64
    public let endDriftUS: Int64
    public let syncToleranceUS: UInt64
    public let pauseMappingValid: Bool
    public let continuityGaps: UInt64
    public let ledger: [RecordingV4AudioLedgerEntry]
    public let failureCodes: [HelperFailureCode]

    public var dictionary: [String: Any] {
        [
            "role": role.rawValue,
            "requested": true,
            "status": failureCodes.isEmpty ? "captured" : "failed",
            "codec": codec,
            "sample_rate_hz": sampleRate,
            "channels": channels,
            "started_offset_us": startedOffsetUS,
            "duration_us": durationUS,
            "end_drift_us": endDriftUS,
            "sync_tolerance_us": syncToleranceUS,
            "pause_mapping_valid": pauseMappingValid,
            "continuity_gaps": continuityGaps,
            "ledger": ledger.map(\.dictionary),
            "failure_codes": failureCodes.map(\.rawValue),
        ]
    }
}

public struct RecordingV4AudioLedger: Sendable {
    public let role: RecordingV4AudioRole
    public let sampleRate: Int
    public let channels: Int
    public let syncToleranceUS: UInt64
    private var entries: [RecordingV4AudioLedgerEntry] = []
    private var continuityGaps: UInt64 = 0

    public init(role: RecordingV4AudioRole, sampleRate: Int, channels: Int, syncToleranceUS: UInt64 = 50_000) throws {
        guard sampleRate > 0, channels > 0, syncToleranceUS > 0 else {
            throw HelperFailureCode.audioFormatInvalid
        }
        self.role = role
        self.sampleRate = sampleRate
        self.channels = channels
        self.syncToleranceUS = syncToleranceUS
    }

    public mutating func append(ptsUS: UInt64, frames: UInt64) throws {
        guard frames > 0 else { throw HelperFailureCode.audioFormatInvalid }
        let duration = (frames * 1_000_000 + UInt64(sampleRate / 2)) / UInt64(sampleRate)
        if let previous = entries.last {
            let expected = previous.ptsUS + previous.durationUS
            let delta = expected > ptsUS ? expected - ptsUS : ptsUS - expected
            if delta > syncToleranceUS { continuityGaps += 1 }
        }
        entries.append(.init(
            sequence: UInt64(entries.count),
            ptsUS: ptsUS,
            durationUS: duration,
            frames: frames
        ))
    }

    public func evidence(activeDurationUS: UInt64, codec: String = "aac") -> RecordingV4AudioEvidence {
        let start = entries.first?.ptsUS ?? 0
        let end = entries.last.map { $0.ptsUS + $0.durationUS } ?? 0
        let endDrift = Int64(end) - Int64(activeDurationUS)
        let withinStartTolerance = start <= syncToleranceUS
        let withinEndTolerance = endDrift.magnitude <= syncToleranceUS
        let failureCodes: [HelperFailureCode] = entries.isEmpty || continuityGaps > 0 ||
            !withinStartTolerance || !withinEndTolerance
            ? [.audioContinuityFailed]
            : []
        return RecordingV4AudioEvidence(
            role: role,
            sampleRate: sampleRate,
            channels: channels,
            codec: codec,
            startedOffsetUS: Int64(start),
            durationUS: end >= start ? end - start : 0,
            endDriftUS: endDrift,
            syncToleranceUS: syncToleranceUS,
            pauseMappingValid: true,
            continuityGaps: continuityGaps,
            ledger: entries,
            failureCodes: failureCodes
        )
    }
}

public struct RecordingV4EncoderEvidence: Sendable {
    public let envelope: RecordingV4EncoderEnvelope
    public let averageBitrateBPS: Int
    public let peakBitrateBPS: Int

    public init(envelope: RecordingV4EncoderEnvelope, averageBitrateBPS: Int, peakBitrateBPS: Int) throws {
        try envelope.validate()
        guard averageBitrateBPS > 0, peakBitrateBPS >= averageBitrateBPS else {
            throw HelperFailureCode.encoderWarmupFailed
        }
        self.envelope = envelope
        self.averageBitrateBPS = averageBitrateBPS
        self.peakBitrateBPS = peakBitrateBPS
    }

    public var dictionary: [String: Any] {
        [
            "encoder_id": envelope.encoderID,
            "hardware_accelerated": true,
            "requested_bitrate_bps": envelope.targetBitrateBPS,
            "average_bitrate_bps": averageBitrateBPS,
            "peak_bitrate_bps": peakBitrateBPS,
            "envelope": [
                "source": envelope.source,
                "encoder_id": envelope.encoderID,
                "minimum_bitrate_bps": envelope.minimumBitrateBPS,
                "target_bitrate_bps": envelope.targetBitrateBPS,
                "maximum_bitrate_bps": envelope.maximumBitrateBPS,
                "safety_headroom_ratio": envelope.safetyHeadroomRatio,
            ],
        ]
    }
}
