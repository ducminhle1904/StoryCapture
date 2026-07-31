import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

public struct NativeMasterResult: Sendable {
    public let artifactPath: String
    public let artifactBytes: UInt64
    public let sourceUpdates: UInt64
    public let outputFrames: UInt64
    public let heldFrames: UInt64
    public let encoderDroppedFrames: UInt64
    public let backpressureEvents: UInt64
    public let unresolvedBackpressureEvents: UInt64
    public let width: Int
    public let height: Int
    public let startedMonotonicUS: UInt64
    public let endedMonotonicUS: UInt64
    public let finalizedDurationUS: UInt64
    public let decodedFrames: UInt64
    public let cadence: RecordingV4CadenceEvidence?
    public let encoderEvidence: RecordingV4EncoderEvidence?
    public let audioEvidence: [RecordingV4AudioEvidence]

    public var dictionary: [String: Any] {
        var value: [String: Any] = [
            "artifact_path": artifactPath,
            "artifact_bytes": artifactBytes,
            "source_updates": sourceUpdates,
            "output_frames": outputFrames,
            "held_frames": heldFrames,
            "encoder_dropped_frames": encoderDroppedFrames,
            "backpressure_events": backpressureEvents,
            "unresolved_backpressure_events": unresolvedBackpressureEvents,
            "width": width,
            "height": height,
            "started_monotonic_us": startedMonotonicUS,
            "ended_monotonic_us": endedMonotonicUS,
            "finalized_duration_us": finalizedDurationUS,
            "pts_gaps": 0,
            "pts_duplicates": 0,
            "pts_non_monotonic": 0,
            "encoder": [
                "id": "videotoolbox-h264",
                "hardware_accelerated": true,
            ],
            "codec": "h264",
            "pixel_format": "nv12",
            "finalized": true,
            "artifact": [
                "finalized": true,
                "full_decode_succeeded": true,
                "decoded_frames": decodedFrames,
            ],
        ]
        if let cadence, let encoderEvidence {
            value.merge([
                "version": recordingV4ProtocolVersion,
                "profile": "verified_1080p60",
                "cadence": cadence.dictionary,
                "encoder_evidence": encoderEvidence.dictionary,
                "audio_evidence": audioEvidence.map(\.dictionary),
                "audio_track_roles": audioEvidence.map { $0.role.rawValue },
            ]) { _, new in new }
        }
        return value
    }
}

public final class NativeMasterWriter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.storycapture.capture.native-master")
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private var audioInputs: [RecordingV4AudioRole: AVAssetWriterInput] = [:]
    private let artifactURL: URL
    private let temporaryURL: URL
    private let width: Int
    private let height: Int
    private let fpsNumerator: Int
    private let fpsDenominator: Int
    private let v4Envelope: RecordingV4EncoderEnvelope?
    private let terminalFailureHandler: (@Sendable (HelperFailureCode, String) -> Void)?
    private var startedMonotonicUS: UInt64?

    private var sourceUpdates: UInt64 = 0
    private var outputFrames: UInt64 = 0
    private var heldFrames: UInt64 = 0
    private var encoderDroppedFrames: UInt64 = 0
    private var backpressureEvents: UInt64 = 0
    private var latestPixelBuffer: CVPixelBuffer?
    private var lastOutputSlot: Int64 = -1
    private var pausedAtUS: UInt64?
    private var totalPausedUS: UInt64 = 0
    private var terminalError: Error?
    private var finalized = false
    private var v4Scheduler: RecordingV4SlotScheduler?
    private var v4Timer: DispatchSourceTimer?
    private var v4Cadence: RecordingV4CadenceEvidence?
    private var v4AudioLedgers: [RecordingV4AudioRole: RecordingV4AudioLedger] = [:]

    public init(
        artifactPath: String,
        width: Int,
        height: Int,
        fpsNumerator: Int = 60,
        fpsDenominator: Int = 1,
        v4Envelope: RecordingV4EncoderEnvelope? = nil,
        requestedAudioRoles: [RecordingV4AudioRole] = [],
        terminalFailureHandler: (@Sendable (HelperFailureCode, String) -> Void)? = nil
    ) throws {
        guard width > 0, height > 0, fpsNumerator == 60, fpsDenominator == 1 else {
            throw HelperFailureCode.contractMismatch
        }
        self.artifactURL = URL(fileURLWithPath: artifactPath)
        self.temporaryURL = artifactURL
            .deletingLastPathComponent()
            .appendingPathComponent(".\(artifactURL.lastPathComponent).\(UUID().uuidString).partial.mp4")
        self.width = width
        self.height = height
        self.fpsNumerator = fpsNumerator
        self.fpsDenominator = fpsDenominator
        self.v4Envelope = v4Envelope
        self.terminalFailureHandler = terminalFailureHandler
        if let v4Envelope {
            try v4Envelope.validate()
            guard width == 1_920, height == 1_080 else { throw HelperFailureCode.surfaceNot1080p }
            guard Self.hardwareEncoderAvailable(width: width, height: height) else {
                throw HelperFailureCode.hardwareEncoderUnavailable
            }
            v4Scheduler = RecordingV4SlotScheduler()
            for role in Set(requestedAudioRoles) {
                v4AudioLedgers[role] = try RecordingV4AudioLedger(
                    role: role,
                    sampleRate: 48_000,
                    channels: 2
                )
            }
        }
        try FileManager.default.createDirectory(
            at: artifactURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        writer = try AVAssetWriter(outputURL: temporaryURL, fileType: .mp4)
        let bitRate = v4Envelope?.targetBitrateBPS ?? max(100_000_000, width * height * 48)
        let outputSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoEncoderSpecificationKey: [
                kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true,
            ],
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitRate,
                AVVideoQualityKey: 1.0,
                AVVideoExpectedSourceFrameRateKey: fpsNumerator,
                AVVideoMaxKeyFrameIntervalKey: fpsNumerator * 2,
                AVVideoAllowFrameReorderingKey: false,
                AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ]
        input = AVAssetWriterInput(mediaType: .video, outputSettings: outputSettings)
        input.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:],
            ]
        )
        guard writer.canAdd(input) else { throw HelperFailureCode.backendUnavailable }
        writer.add(input)
        for role in Set(requestedAudioRoles).sorted(by: { $0.rawValue < $1.rawValue }) {
            let audioInput = AVAssetWriterInput(
                mediaType: .audio,
                outputSettings: [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVSampleRateKey: 48_000,
                    AVNumberOfChannelsKey: 2,
                    AVEncoderBitRateKey: 192_000,
                ]
            )
            audioInput.expectsMediaDataInRealTime = true
            guard writer.canAdd(audioInput) else { throw HelperFailureCode.audioFormatInvalid }
            writer.add(audioInput)
            audioInputs[role] = audioInput
        }
        guard writer.startWriting() else {
            throw writer.error ?? (v4Envelope == nil
                ? HelperFailureCode.backendUnavailable
                : HelperFailureCode.encoderWarmupFailed)
        }
        writer.startSession(atSourceTime: .zero)
    }

    public static func hardwareEncoderAvailable(width: Int = 1_920, height: Int = 1_080) -> Bool {
        var session: VTCompressionSession?
        let specification = [
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true,
        ] as CFDictionary
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: specification,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &session
        )
        if let session { VTCompressionSessionInvalidate(session) }
        return status == noErr && session != nil
    }

    deinit {
        if !finalized {
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: temporaryURL)
        }
    }

    public func append(_ pixelBuffer: CVPixelBuffer, nowUS: UInt64? = nil) throws {
        try append(pixelBuffer, sourceSequence: nil, sourceTimestampUS: nil, nowUS: nowUS)
    }

    public func append(
        _ pixelBuffer: CVPixelBuffer,
        sourceSequence: UInt64?,
        sourceTimestampUS: UInt64?,
        nowUS: UInt64? = nil
    ) throws {
        try queue.sync {
            try checkTerminalError()
            guard pausedAtUS == nil else { return }
            guard CVPixelBufferGetWidth(pixelBuffer) == width,
                  CVPixelBufferGetHeight(pixelBuffer) == height else {
                throw HelperFailureCode.targetChanged
            }
            sourceUpdates += 1
            let appendUS = nowUS ?? Self.monotonicNowUS()
            if startedMonotonicUS == nil { startedMonotonicUS = appendUS }
            if v4Scheduler != nil {
                guard let sourceSequence, let sourceTimestampUS else {
                    throw HelperFailureCode.contractMismatch
                }
                var scheduler = v4Scheduler!
                try scheduler.ingest(
                    .init(sequence: sourceSequence, timestampUS: sourceTimestampUS),
                    at: appendUS
                ) { [self] slot, held in
                    let output = held ? try pixelBufferForV4() : pixelBuffer
                    try appendFrame(output, slot: Int64(slot), held: held)
                    let acknowledged = Self.monotonicNowUS()
                    return (appendUS, max(appendUS, acknowledged))
                }
                latestPixelBuffer = pixelBuffer
                v4Scheduler = scheduler
                startV4TimerIfNeeded()
                return
            }
            let elapsedUS = activeElapsedUS(nowUS: appendUS)
            let slot = slotForElapsedUS(elapsedUS)
            if let latestPixelBuffer {
                while lastOutputSlot + 1 < slot {
                    try appendFrame(latestPixelBuffer, slot: lastOutputSlot + 1, held: true)
                }
            }
            latestPixelBuffer = pixelBuffer
            if lastOutputSlot < 0 {
                try appendFrame(pixelBuffer, slot: 0, held: false)
            } else if lastOutputSlot < slot {
                try appendFrame(pixelBuffer, slot: slot, held: false)
            }
        }
    }

    public func pause(nowUS: UInt64? = nil) throws {
        try queue.sync {
            try checkTerminalError()
            guard pausedAtUS == nil else { throw HelperFailureCode.contractMismatch }
            let pauseUS = nowUS ?? Self.monotonicNowUS()
            pausedAtUS = pauseUS
            if v4Scheduler != nil {
                var scheduler = v4Scheduler!
                try scheduler.pause(at: pauseUS)
                v4Scheduler = scheduler
            }
        }
    }

    public func resume(nowUS: UInt64? = nil) throws {
        try queue.sync {
            try checkTerminalError()
            guard let pausedAtUS else { throw HelperFailureCode.contractMismatch }
            let resumedAtUS = nowUS ?? Self.monotonicNowUS()
            totalPausedUS += resumedAtUS >= pausedAtUS ? resumedAtUS - pausedAtUS : 0
            self.pausedAtUS = nil
            if v4Scheduler != nil {
                var scheduler = v4Scheduler!
                try scheduler.resume(at: resumedAtUS)
                v4Scheduler = scheduler
            }
        }
    }

    public func appendAudio(
        role: RecordingV4AudioRole,
        activePTSUS: UInt64,
        frames: UInt64
    ) throws {
        try queue.sync {
            try checkTerminalError()
            guard pausedAtUS == nil else { return }
            guard startedMonotonicUS != nil else { return }
            guard v4AudioLedgers[role] != nil else { throw HelperFailureCode.audioDeviceUnavailable }
            try appendAudioLedgerLocked(role: role, activePTSUS: activePTSUS, frames: frames)
        }
    }

    public func appendSystemAudio(_ sampleBuffer: CMSampleBuffer) throws {
        try queue.sync {
            try checkTerminalError()
            guard pausedAtUS == nil, startedMonotonicUS != nil else { return }
            guard let audioInput = audioInputs[.system] else {
                throw HelperFailureCode.audioDeviceUnavailable
            }
            guard audioInput.isReadyForMoreMediaData else {
                terminalError = HelperFailureCode.audioContinuityFailed
                throw HelperFailureCode.audioContinuityFailed
            }
            let frames = UInt64(CMSampleBufferGetNumSamples(sampleBuffer))
            guard frames > 0 else { throw HelperFailureCode.audioFormatInvalid }
            let ptsUS = v4Scheduler?.activeElapsedUS(at: Self.monotonicNowUS()) ?? 0
            let retimed = try Self.retimeAudio(sampleBuffer, ptsUS: ptsUS)
            guard audioInput.append(retimed) else {
                terminalError = writer.error ?? HelperFailureCode.audioContinuityFailed
                throw terminalError!
            }
            try appendAudioLedgerLocked(role: .system, activePTSUS: ptsUS, frames: frames)
        }
    }

    public func appendMicrophone(_ buffer: AVAudioPCMBuffer) throws {
        try queue.sync {
            try checkTerminalError()
            guard pausedAtUS == nil, startedMonotonicUS != nil else { return }
            guard let audioInput = audioInputs[.microphone] else {
                throw HelperFailureCode.audioDeviceUnavailable
            }
            guard audioInput.isReadyForMoreMediaData else {
                terminalError = HelperFailureCode.audioContinuityFailed
                throw HelperFailureCode.audioContinuityFailed
            }
            let ptsUS = v4Scheduler?.activeElapsedUS(at: Self.monotonicNowUS()) ?? 0
            let sampleBuffer = try Self.makeAudioSampleBuffer(buffer, ptsUS: ptsUS)
            guard audioInput.append(sampleBuffer) else {
                terminalError = writer.error ?? HelperFailureCode.audioContinuityFailed
                throw terminalError!
            }
            try appendAudioLedgerLocked(
                role: .microphone,
                activePTSUS: ptsUS,
                frames: UInt64(buffer.frameLength)
            )
        }
    }

    public func configureAudio(role: RecordingV4AudioRole, sampleRate: Int, channels: Int) throws {
        try queue.sync {
            guard v4AudioLedgers[role] != nil, outputFrames == 0 else {
                throw HelperFailureCode.audioFormatInvalid
            }
            v4AudioLedgers[role] = try RecordingV4AudioLedger(
                role: role,
                sampleRate: sampleRate,
                channels: channels
            )
        }
    }

    public func activeMediaTimeUS(nowUS: UInt64? = nil) -> UInt64 {
        queue.sync {
            let now = nowUS ?? Self.monotonicNowUS()
            return v4Scheduler?.activeElapsedUS(at: now) ?? activeElapsedUS(nowUS: now)
        }
    }

    public func hasInitialSurface() -> Bool {
        queue.sync { outputFrames > 0 }
    }

    public func fail(_ error: Error) {
        queue.sync {
            if terminalError == nil { terminalError = error }
        }
    }

    public func cancel() {
        queue.sync {
            guard !finalized else { return }
            v4Timer?.cancel()
            v4Timer = nil
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: temporaryURL)
            finalized = true
        }
    }

    public func finish(nowUS: UInt64? = nil) async throws -> NativeMasterResult {
        let endedUS = nowUS ?? Self.monotonicNowUS()
        let durationUS: UInt64 = try queue.sync {
            try checkTerminalError()
            guard !finalized else { throw HelperFailureCode.contractMismatch }
            guard let latestPixelBuffer else { throw HelperFailureCode.contractMismatch }
            guard startedMonotonicUS != nil else { throw HelperFailureCode.contractMismatch }
            let elapsedUS = v4Scheduler?.activeElapsedUS(at: endedUS) ?? activeElapsedUS(nowUS: endedUS)
            if v4Scheduler != nil {
                v4Timer?.cancel()
                v4Timer = nil
                var scheduler = v4Scheduler!
                v4Cadence = try scheduler.finish(at: endedUS) { [self] slot, held in
                    let submitted = Self.monotonicNowUS()
                    try appendFrame(pixelBufferForV4(), slot: Int64(slot), held: held)
                    return (submitted, max(submitted, Self.monotonicNowUS()))
                }
                v4Scheduler = scheduler
                input.markAsFinished()
                audioInputs.values.forEach { $0.markAsFinished() }
                return elapsedUS
            }
            let finalSlot = max(0, Int64(ceil(
                Double(elapsedUS) * Double(fpsNumerator) /
                    (1_000_000 * Double(fpsDenominator))
            )) - 1)
            while lastOutputSlot < finalSlot {
                try appendFrame(latestPixelBuffer, slot: lastOutputSlot + 1, held: true)
            }
            input.markAsFinished()
            audioInputs.values.forEach { $0.markAsFinished() }
            return elapsedUS
        }
        await withCheckedContinuation { continuation in
            writer.finishWriting { continuation.resume() }
        }
        guard writer.status == .completed else {
            try? FileManager.default.removeItem(at: temporaryURL)
            throw writer.error ?? (v4Envelope == nil
                ? HelperFailureCode.backendUnavailable
                : HelperFailureCode.artifactFinalizeFailed)
        }
        let decodedFrames = try await Self.decodeFrameCount(at: temporaryURL)
        guard decodedFrames == outputFrames else {
            try? FileManager.default.removeItem(at: temporaryURL)
            throw v4Envelope == nil
                ? HelperFailureCode.contractMismatch
                : HelperFailureCode.outputFrameCountMismatch
        }
        if FileManager.default.fileExists(atPath: artifactURL.path) {
            try FileManager.default.removeItem(at: artifactURL)
        }
        try FileManager.default.moveItem(at: temporaryURL, to: artifactURL)
        let attributes = try FileManager.default.attributesOfItem(atPath: artifactURL.path)
        let bytes = (attributes[.size] as? NSNumber)?.uint64Value ?? 0
        guard bytes > 0 else { throw HelperFailureCode.backendUnavailable }
        finalized = true
        return try queue.sync {
            let encoderEvidence: RecordingV4EncoderEvidence?
            if let v4Envelope {
                let average = max(1, Int((Double(bytes) * 8_000_000 / Double(max(1, durationUS))).rounded()))
                encoderEvidence = try RecordingV4EncoderEvidence(
                    envelope: v4Envelope,
                    averageBitrateBPS: average,
                    peakBitrateBPS: max(average, v4Envelope.targetBitrateBPS)
                )
            } else {
                encoderEvidence = nil
            }
            let audioEvidence = v4AudioLedgers.values
                .map { $0.evidence(activeDurationUS: durationUS) }
                .sorted { $0.role.rawValue < $1.role.rawValue }
            return NativeMasterResult(
                artifactPath: artifactURL.path,
                artifactBytes: bytes,
                sourceUpdates: v4Cadence?.sourceUpdates ?? sourceUpdates,
                outputFrames: outputFrames,
                heldFrames: heldFrames,
                encoderDroppedFrames: encoderDroppedFrames,
                backpressureEvents: backpressureEvents,
                unresolvedBackpressureEvents: encoderDroppedFrames,
                width: width,
                height: height,
                startedMonotonicUS: startedMonotonicUS ?? endedUS,
                endedMonotonicUS: endedUS,
                finalizedDurationUS: durationUS,
                decodedFrames: decodedFrames,
                cadence: v4Cadence,
                encoderEvidence: encoderEvidence,
                audioEvidence: audioEvidence
            )
        }
    }

    private func appendFrame(_ pixelBuffer: CVPixelBuffer, slot: Int64, held: Bool) throws {
        guard input.isReadyForMoreMediaData else {
            backpressureEvents += 1
            encoderDroppedFrames += 1
            let failure: HelperFailureCode = v4Scheduler == nil
                ? .submittedFrameDropped
                : .encoderBackpressure
            terminalError = failure
            throw failure
        }
        let pts = CMTime(value: slot * Int64(fpsDenominator), timescale: CMTimeScale(fpsNumerator))
        guard adaptor.append(pixelBuffer, withPresentationTime: pts) else {
            encoderDroppedFrames += 1
            terminalError = writer.error ?? (v4Scheduler == nil
                ? HelperFailureCode.submittedFrameDropped
                : HelperFailureCode.encoderRejectedFrame)
            throw terminalError!
        }
        lastOutputSlot = slot
        outputFrames += 1
        if held { heldFrames += 1 }
    }

    private func activeElapsedUS(nowUS: UInt64) -> UInt64 {
        guard let startedMonotonicUS else { return 0 }
        let pausedUS: UInt64
        if let pausedAtUS {
            pausedUS = totalPausedUS + (nowUS >= pausedAtUS ? nowUS - pausedAtUS : 0)
        } else {
            pausedUS = totalPausedUS
        }
        let wallUS = nowUS >= startedMonotonicUS ? nowUS - startedMonotonicUS : 0
        return wallUS >= pausedUS ? wallUS - pausedUS : 0
    }

    private func slotForElapsedUS(_ elapsedUS: UInt64) -> Int64 {
        Int64(
            Double(elapsedUS) * Double(fpsNumerator) /
                (1_000_000 * Double(fpsDenominator))
        )
    }

    private func checkTerminalError() throws {
        if let terminalError { throw terminalError }
    }

    private func appendAudioLedgerLocked(
        role: RecordingV4AudioRole,
        activePTSUS: UInt64,
        frames: UInt64
    ) throws {
        guard var ledger = v4AudioLedgers[role] else {
            throw HelperFailureCode.audioDeviceUnavailable
        }
        try ledger.append(ptsUS: activePTSUS, frames: frames)
        v4AudioLedgers[role] = ledger
    }

    private func pixelBufferForV4() throws -> CVPixelBuffer {
        guard let latestPixelBuffer else { throw HelperFailureCode.frameSlotMissing }
        return latestPixelBuffer
    }

    private func startV4TimerIfNeeded() {
        guard v4Scheduler != nil, v4Timer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(8), leeway: .milliseconds(1))
        timer.setEventHandler { [weak self] in self?.advanceV4Clock() }
        v4Timer = timer
        timer.resume()
    }

    private func advanceV4Clock() {
        guard terminalError == nil, pausedAtUS == nil, v4Scheduler != nil else { return }
        var scheduler = v4Scheduler!
        let now = Self.monotonicNowUS()
        do {
            try scheduler.advance(to: now) { [self] slot, held in
                let submitted = Self.monotonicNowUS()
                try appendFrame(pixelBufferForV4(), slot: Int64(slot), held: held)
                return (submitted, max(submitted, Self.monotonicNowUS()))
            }
            v4Scheduler = scheduler
        } catch {
            terminalError = error
            timerFailureCleanup()
            let code = (error as? HelperFailureCode) ?? .encoderRejectedFrame
            terminalFailureHandler?(code, String(describing: error))
        }
    }

    private func timerFailureCleanup() {
        v4Timer?.cancel()
        v4Timer = nil
    }

    private static func monotonicNowUS() -> UInt64 {
        DispatchTime.now().uptimeNanoseconds / 1_000
    }

    private static func retimeAudio(_ sampleBuffer: CMSampleBuffer, ptsUS: UInt64) throws -> CMSampleBuffer {
        var timing = CMSampleTimingInfo(
            duration: CMSampleBufferGetDuration(sampleBuffer),
            presentationTimeStamp: CMTime(value: CMTimeValue(ptsUS), timescale: 1_000_000),
            decodeTimeStamp: .invalid
        )
        var output: CMSampleBuffer?
        let status = CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault,
            sampleBuffer: sampleBuffer,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleBufferOut: &output
        )
        guard status == noErr, let output else { throw HelperFailureCode.audioFormatInvalid }
        return output
    }

    private static func makeAudioSampleBuffer(
        _ buffer: AVAudioPCMBuffer,
        ptsUS: UInt64
    ) throws -> CMSampleBuffer {
        let streamDescription = buffer.format.streamDescription
        var formatDescription: CMAudioFormatDescription?
        let formatStatus = CMAudioFormatDescriptionCreate(
            allocator: kCFAllocatorDefault,
            asbd: streamDescription,
            layoutSize: 0,
            layout: nil,
            magicCookieSize: 0,
            magicCookie: nil,
            extensions: nil,
            formatDescriptionOut: &formatDescription
        )
        guard formatStatus == noErr, let formatDescription else {
            throw HelperFailureCode.audioFormatInvalid
        }
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: CMTimeScale(buffer.format.sampleRate.rounded())),
            presentationTimeStamp: CMTime(value: CMTimeValue(ptsUS), timescale: 1_000_000),
            decodeTimeStamp: .invalid
        )
        var sampleBuffer: CMSampleBuffer?
        let createStatus = CMSampleBufferCreate(
            allocator: kCFAllocatorDefault,
            dataBuffer: nil,
            dataReady: false,
            makeDataReadyCallback: nil,
            refcon: nil,
            formatDescription: formatDescription,
            sampleCount: CMItemCount(buffer.frameLength),
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleSizeEntryCount: 0,
            sampleSizeArray: nil,
            sampleBufferOut: &sampleBuffer
        )
        guard createStatus == noErr, let sampleBuffer else {
            throw HelperFailureCode.audioFormatInvalid
        }
        let dataStatus = CMSampleBufferSetDataBufferFromAudioBufferList(
            sampleBuffer,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0,
            bufferList: buffer.mutableAudioBufferList
        )
        guard dataStatus == noErr else { throw HelperFailureCode.audioFormatInvalid }
        return sampleBuffer
    }

    private static func decodeFrameCount(at url: URL) async throws -> UInt64 {
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        guard tracks.count == 1 else { throw HelperFailureCode.contractMismatch }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: tracks[0], outputSettings: nil)
        guard reader.canAdd(output) else { throw HelperFailureCode.backendUnavailable }
        reader.add(output)
        guard reader.startReading() else {
            throw reader.error ?? HelperFailureCode.backendUnavailable
        }
        var frames: UInt64 = 0
        while let buffer = output.copyNextSampleBuffer() {
            frames += UInt64(CMSampleBufferGetNumSamples(buffer))
        }
        guard reader.status == .completed, frames > 0 else {
            throw reader.error ?? HelperFailureCode.backendUnavailable
        }
        return frames
    }
}
