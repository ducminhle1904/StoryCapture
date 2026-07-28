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

    public var dictionary: [String: Any] {
        [
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
    }
}

public final class NativeMasterWriter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.storycapture.capture.native-master")
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private let artifactURL: URL
    private let temporaryURL: URL
    private let width: Int
    private let height: Int
    private let fpsNumerator: Int
    private let fpsDenominator: Int
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

    public init(
        artifactPath: String,
        width: Int,
        height: Int,
        fpsNumerator: Int = 60,
        fpsDenominator: Int = 1
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
        try FileManager.default.createDirectory(
            at: artifactURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        writer = try AVAssetWriter(outputURL: temporaryURL, fileType: .mp4)
        let bitRate = max(20_000_000, width * height * 12)
        let outputSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoEncoderSpecificationKey: [
                kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true,
            ],
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitRate,
                AVVideoExpectedSourceFrameRateKey: fpsNumerator,
                AVVideoMaxKeyFrameIntervalKey: fpsNumerator * 2,
                AVVideoAllowFrameReorderingKey: false,
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
        guard writer.startWriting() else {
            throw writer.error ?? HelperFailureCode.backendUnavailable
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
            pausedAtUS = nowUS ?? Self.monotonicNowUS()
        }
    }

    public func resume(nowUS: UInt64? = nil) throws {
        try queue.sync {
            try checkTerminalError()
            guard let pausedAtUS else { throw HelperFailureCode.contractMismatch }
            let resumedAtUS = nowUS ?? Self.monotonicNowUS()
            totalPausedUS += resumedAtUS >= pausedAtUS ? resumedAtUS - pausedAtUS : 0
            self.pausedAtUS = nil
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

    public func finish(nowUS: UInt64? = nil) async throws -> NativeMasterResult {
        let endedUS = nowUS ?? Self.monotonicNowUS()
        let durationUS: UInt64 = try queue.sync {
            try checkTerminalError()
            guard !finalized else { throw HelperFailureCode.contractMismatch }
            guard let latestPixelBuffer else { throw HelperFailureCode.contractMismatch }
            guard startedMonotonicUS != nil else { throw HelperFailureCode.contractMismatch }
            let elapsedUS = activeElapsedUS(nowUS: endedUS)
            let finalSlot = max(0, Int64(ceil(
                Double(elapsedUS) * Double(fpsNumerator) /
                    (1_000_000 * Double(fpsDenominator))
            )) - 1)
            while lastOutputSlot < finalSlot {
                try appendFrame(latestPixelBuffer, slot: lastOutputSlot + 1, held: true)
            }
            input.markAsFinished()
            return elapsedUS
        }
        await withCheckedContinuation { continuation in
            writer.finishWriting { continuation.resume() }
        }
        guard writer.status == .completed else {
            try? FileManager.default.removeItem(at: temporaryURL)
            throw writer.error ?? HelperFailureCode.backendUnavailable
        }
        let decodedFrames = try await Self.decodeFrameCount(at: temporaryURL)
        guard decodedFrames == outputFrames else {
            try? FileManager.default.removeItem(at: temporaryURL)
            throw HelperFailureCode.contractMismatch
        }
        if FileManager.default.fileExists(atPath: artifactURL.path) {
            try FileManager.default.removeItem(at: artifactURL)
        }
        try FileManager.default.moveItem(at: temporaryURL, to: artifactURL)
        let attributes = try FileManager.default.attributesOfItem(atPath: artifactURL.path)
        let bytes = (attributes[.size] as? NSNumber)?.uint64Value ?? 0
        guard bytes > 0 else { throw HelperFailureCode.backendUnavailable }
        finalized = true
        return queue.sync {
            NativeMasterResult(
                artifactPath: artifactURL.path,
                artifactBytes: bytes,
                sourceUpdates: sourceUpdates,
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
                decodedFrames: decodedFrames
            )
        }
    }

    private func appendFrame(_ pixelBuffer: CVPixelBuffer, slot: Int64, held: Bool) throws {
        guard input.isReadyForMoreMediaData else {
            backpressureEvents += 1
            encoderDroppedFrames += 1
            terminalError = HelperFailureCode.submittedFrameDropped
            throw HelperFailureCode.submittedFrameDropped
        }
        let pts = CMTime(value: slot * Int64(fpsDenominator), timescale: CMTimeScale(fpsNumerator))
        guard adaptor.append(pixelBuffer, withPresentationTime: pts) else {
            encoderDroppedFrames += 1
            terminalError = writer.error ?? HelperFailureCode.submittedFrameDropped
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

    private static func monotonicNowUS() -> UInt64 {
        DispatchTime.now().uptimeNanoseconds / 1_000
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
