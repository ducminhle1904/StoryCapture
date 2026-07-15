import AppKit
import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import Darwin
import Foundation
@preconcurrency import ScreenCaptureKit

enum SpikeRunError: Error, LocalizedError {
    case invalidArgument(String)
    case targetUnavailable(String)
    case backendSegmentUnavailable
    case audioWriter(String)

    var errorDescription: String? {
        switch self {
        case let .invalidArgument(detail): detail
        case let .targetUnavailable(detail): detail
        case .backendSegmentUnavailable: "backend_segment requires macOS 15 or newer"
        case let .audioWriter(detail): detail
        }
    }
}

struct SpikeArguments {
    let runID: String
    let fixtureWindow: Bool
    let targetKind: SpikeTargetKind
    let transport: SpikeTransport
    let width: Int
    let height: Int
    let fps: Int
    let durationMS: Int
    let cursor: Bool
    let audio: Bool
    let requestPermission: Bool
    let displayID: UInt32?
    let windowID: UInt32?
    let ownerPID: Int32?
    let titleContains: String?

    static func parse(_ arguments: [String]) throws -> SpikeArguments {
        var values: [String: String] = [:]
        var flags = Set<String>()
        var index = 1
        while index < arguments.count {
            let key = arguments[index]
            guard key.hasPrefix("--") else {
                throw SpikeRunError.invalidArgument("unexpected argument: \(key)")
            }
            if ["--fixture-window", "--request-permission", "--audio", "--no-cursor"].contains(key) {
                flags.insert(key)
                index += 1
                continue
            }
            guard index + 1 < arguments.count else {
                throw SpikeRunError.invalidArgument("missing value for \(key)")
            }
            values[key] = arguments[index + 1]
            index += 2
        }

        let runID = values["--run-id"] ?? UUID().uuidString.lowercased()
        guard runID.range(of: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$", options: .regularExpression) != nil else {
            throw SpikeRunError.invalidArgument("run-id is not safe")
        }
        let targetKind = SpikeTargetKind(rawValue: values["--target"] ?? "display")
        guard let targetKind else { throw SpikeRunError.invalidArgument("unsupported target") }
        let transport = SpikeTransport(rawValue: values["--transport"] ?? "host_frames")
        guard let transport else { throw SpikeRunError.invalidArgument("unsupported transport") }
        let width = Int(values["--width"] ?? "1920") ?? 0
        let height = Int(values["--height"] ?? "1080") ?? 0
        let fps = Int(values["--fps"] ?? "30") ?? 0
        let durationMS = Int(values["--duration-ms"] ?? "5000") ?? 0
        guard (16 ... 7680).contains(width), (16 ... 4320).contains(height) else {
            throw SpikeRunError.invalidArgument("capture dimensions are out of bounds")
        }
        guard (1 ... 120).contains(fps), (100 ... 900_000).contains(durationMS) else {
            throw SpikeRunError.invalidArgument("fps or duration is out of bounds")
        }
        return SpikeArguments(
            runID: runID,
            fixtureWindow: flags.contains("--fixture-window"),
            targetKind: targetKind,
            transport: transport,
            width: width,
            height: height,
            fps: fps,
            durationMS: durationMS,
            cursor: !flags.contains("--no-cursor"),
            audio: flags.contains("--audio"),
            requestPermission: flags.contains("--request-permission"),
            displayID: values["--display-id"].flatMap(UInt32.init),
            windowID: values["--window-id"].flatMap(UInt32.init),
            ownerPID: values["--pid"].flatMap(Int32.init),
            titleContains: values["--title"]
        )
    }
}

private struct AudioFinalization {
    let path: String?
    let bytes: Int64?
    let status: String
}

private final class AudioStemWriter: @unchecked Sendable {
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let outputURL: URL
    private var started = false
    private var appendFailed = false

    init(outputURL: URL) throws {
        self.outputURL = outputURL
        try? FileManager.default.removeItem(at: outputURL)
        writer = try AVAssetWriter(outputURL: outputURL, fileType: .m4a)
        input = AVAssetWriterInput(
            mediaType: .audio,
            outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 128_000,
            ]
        )
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else {
            throw SpikeRunError.audioWriter("AVAssetWriter rejected the audio input")
        }
        writer.add(input)
    }

    func append(_ sampleBuffer: CMSampleBuffer) {
        guard !appendFailed else { return }
        if !started {
            guard writer.startWriting() else {
                appendFailed = true
                return
            }
            writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
            started = true
        }
        if input.isReadyForMoreMediaData, !input.append(sampleBuffer) {
            appendFailed = true
        }
    }

    func finish() async -> AudioFinalization {
        guard started else {
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: outputURL)
            return AudioFinalization(path: nil, bytes: nil, status: "no_samples")
        }
        input.markAsFinished()
        await withCheckedContinuation { continuation in
            writer.finishWriting { continuation.resume() }
        }
        let status: String
        switch writer.status {
        case .completed: status = appendFailed ? "completed_with_append_failure" : "completed"
        case .failed: status = "failed:\(writer.error?.localizedDescription ?? "unknown")"
        case .cancelled: status = "cancelled"
        default: status = "unexpected:\(writer.status.rawValue)"
        }
        let bytes = (try? FileManager.default.attributesOfItem(atPath: outputURL.path)[.size] as? NSNumber)?
            .int64Value
        return AudioFinalization(
            path: FileManager.default.fileExists(atPath: outputURL.path) ? outputURL.path : nil,
            bytes: bytes,
            status: status
        )
    }
}

private struct CollectorSnapshot {
    let frameCount: Int
    let firstPTSNS: Int64?
    let lastPTSNS: Int64?
    let firstFrameDelayMS: Double?
    let nonMonotonicPTS: Int
    let droppedOrMissingFrames: Int
    let maxFrameGapMS: Double
    let formatChangeCount: Int
    let observedFormats: [String]
    let frameStatusCounts: [String: Int]
    let audioBufferCount: Int
    let audioSampleCount: Int
    let audioFirstPTSNS: Int64?
    let audioLastPTSNS: Int64?
    let audioNonMonotonicPTS: Int
    let audioZeroBufferCount: Int
    let audioSampleRate: Double?
    let audioChannelCount: UInt32?
    let firstAudioDelayMS: Double?
    let terminalReason: String?
}

private final class CaptureCollector: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let expectedFrameNS: Int64
    private let startedUptimeNS: UInt64
    private let audioWriter: AudioStemWriter?
    private var frameCount = 0
    private var firstPTSNS: Int64?
    private var lastPTSNS: Int64?
    private var firstFrameDelayMS: Double?
    private var nonMonotonicPTS = 0
    private var droppedOrMissingFrames = 0
    private var maxFrameGapMS = 0.0
    private var formatChangeCount = 0
    private var lastFormat: String?
    private var observedFormats = Set<String>()
    private var frameStatusCounts: [String: Int] = [:]
    private var audioBufferCount = 0
    private var audioSampleCount = 0
    private var audioFirstPTSNS: Int64?
    private var audioLastPTSNS: Int64?
    private var audioNonMonotonicPTS = 0
    private var audioZeroBufferCount = 0
    private var audioSampleRate: Double?
    private var audioChannelCount: UInt32?
    private var firstAudioDelayMS: Double?
    private var terminalReason: String?

    init(fps: Int, startedUptimeNS: UInt64, audioWriter: AudioStemWriter?) {
        expectedFrameNS = Int64(1_000_000_000 / max(1, fps))
        self.startedUptimeNS = startedUptimeNS
        self.audioWriter = audioWriter
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard CMSampleBufferIsValid(sampleBuffer) else { return }
        switch outputType {
        case .screen: observeScreen(sampleBuffer)
        case .audio: observeAudio(sampleBuffer)
        default: break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.withLock { terminalReason = error.localizedDescription }
    }

    func snapshot() -> CollectorSnapshot {
        lock.withLock {
            CollectorSnapshot(
                frameCount: frameCount,
                firstPTSNS: firstPTSNS,
                lastPTSNS: lastPTSNS,
                firstFrameDelayMS: firstFrameDelayMS,
                nonMonotonicPTS: nonMonotonicPTS,
                droppedOrMissingFrames: droppedOrMissingFrames,
                maxFrameGapMS: maxFrameGapMS,
                formatChangeCount: formatChangeCount,
                observedFormats: observedFormats.sorted(),
                frameStatusCounts: frameStatusCounts,
                audioBufferCount: audioBufferCount,
                audioSampleCount: audioSampleCount,
                audioFirstPTSNS: audioFirstPTSNS,
                audioLastPTSNS: audioLastPTSNS,
                audioNonMonotonicPTS: audioNonMonotonicPTS,
                audioZeroBufferCount: audioZeroBufferCount,
                audioSampleRate: audioSampleRate,
                audioChannelCount: audioChannelCount,
                firstAudioDelayMS: firstAudioDelayMS,
                terminalReason: terminalReason
            )
        }
    }

    private func observeScreen(_ sampleBuffer: CMSampleBuffer) {
        let now = DispatchTime.now().uptimeNanoseconds
        let ptsNS = nanoseconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        let status = frameStatus(sampleBuffer)
        guard status == "complete" || status == "started" else {
            lock.withLock { frameStatusCounts[status, default: 0] += 1 }
            return
        }
        guard let image = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let format = "\(CVPixelBufferGetWidth(image))x\(CVPixelBufferGetHeight(image)):\(fourCC(CVPixelBufferGetPixelFormatType(image)))"
        lock.withLock {
            frameStatusCounts[status, default: 0] += 1
            frameCount += 1
            observedFormats.insert(format)
            if let lastFormat, lastFormat != format { formatChangeCount += 1 }
            lastFormat = format
            if firstFrameDelayMS == nil {
                firstFrameDelayMS = Double(now - startedUptimeNS) / 1_000_000
            }
            guard let ptsNS else { return }
            if firstPTSNS == nil { firstPTSNS = ptsNS }
            if let previous = lastPTSNS {
                if ptsNS <= previous {
                    nonMonotonicPTS += 1
                } else {
                    let gap = ptsNS - previous
                    maxFrameGapMS = max(maxFrameGapMS, Double(gap) / 1_000_000)
                    if gap > expectedFrameNS * 3 / 2 {
                        droppedOrMissingFrames += max(0, Int((gap + expectedFrameNS / 2) / expectedFrameNS) - 1)
                    }
                }
            }
            lastPTSNS = ptsNS
        }
    }

    private func observeAudio(_ sampleBuffer: CMSampleBuffer) {
        let now = DispatchTime.now().uptimeNanoseconds
        let ptsNS = nanoseconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        let samples = CMSampleBufferGetNumSamples(sampleBuffer)
        let zeroValued = sampleBufferIsAllZero(sampleBuffer)
        var sampleRate: Double?
        var channels: UInt32?
        if let format = CMSampleBufferGetFormatDescription(sampleBuffer),
           let basic = CMAudioFormatDescriptionGetStreamBasicDescription(format)
        {
            sampleRate = basic.pointee.mSampleRate
            channels = basic.pointee.mChannelsPerFrame
        }
        lock.withLock {
            audioBufferCount += 1
            audioSampleCount += samples
            if zeroValued { audioZeroBufferCount += 1 }
            if audioSampleRate == nil { audioSampleRate = sampleRate }
            if audioChannelCount == nil { audioChannelCount = channels }
            if firstAudioDelayMS == nil {
                firstAudioDelayMS = Double(now - startedUptimeNS) / 1_000_000
            }
            guard let ptsNS else { return }
            if audioFirstPTSNS == nil { audioFirstPTSNS = ptsNS }
            if let previous = audioLastPTSNS, ptsNS <= previous { audioNonMonotonicPTS += 1 }
            audioLastPTSNS = ptsNS
        }
        audioWriter?.append(sampleBuffer)
    }
}

@available(macOS 15.0, *)
private final class RecordingObserver: NSObject, SCRecordingOutputDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var current = "configured"

    var status: String { lock.withLock { current } }

    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
        lock.withLock { current = "recording" }
    }

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        lock.withLock { current = "failed:\(error.localizedDescription)" }
    }

    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        lock.withLock { current = "completed" }
    }
}

private extension NSLock {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}

private func nanoseconds(_ time: CMTime) -> Int64? {
    guard time.isValid, !time.isIndefinite else { return nil }
    return CMTimeConvertScale(time, timescale: 1_000_000_000, method: .default).value
}

private func fourCC(_ value: OSType) -> String {
    let bytes: [UInt8] = [24, 16, 8, 0].map { UInt8((value >> OSType($0)) & 0xff) }
    let printable = bytes.map { (32 ... 126).contains($0) ? Character(UnicodeScalar($0)) : "?" }
    return String(printable)
}

private func frameStatus(_ sampleBuffer: CMSampleBuffer) -> String {
    guard
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            as? [[SCStreamFrameInfo: Any]],
        let raw = attachments.first?[.status] as? Int,
        let status = SCFrameStatus(rawValue: raw)
    else { return "unknown" }
    switch status {
    case .complete: return "complete"
    case .idle: return "idle"
    case .blank: return "blank"
    case .suspended: return "suspended"
    case .started: return "started"
    case .stopped: return "stopped"
    @unknown default: return "unknown:\(raw)"
    }
}

private func sampleBufferIsAllZero(_ sampleBuffer: CMSampleBuffer) -> Bool {
    guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return false }
    var lengthAtOffset = 0
    var totalLength = 0
    var pointer: UnsafeMutablePointer<Int8>?
    let status = CMBlockBufferGetDataPointer(
        block,
        atOffset: 0,
        lengthAtOffsetOut: &lengthAtOffset,
        totalLengthOut: &totalLength,
        dataPointerOut: &pointer
    )
    guard status == kCMBlockBufferNoErr, let pointer, totalLength > 0 else { return false }
    return UnsafeRawBufferPointer(start: pointer, count: totalLength).allSatisfy { $0 == 0 }
}

private func hardwareModel() -> String {
    var size = 0
    guard sysctlbyname("hw.model", nil, &size, nil, 0) == 0, size > 0 else { return "unknown" }
    var value = [CChar](repeating: 0, count: size)
    guard sysctlbyname("hw.model", &value, &size, nil, 0) == 0 else { return "unknown" }
    return String(cString: value)
}

private func spikeRunDirectory(_ runID: String) throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
        "storycapture-native-spikes",
        isDirectory: true
    )
    let directory = root.appendingPathComponent(runID, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
}

private func selectedTarget(
    _ arguments: SpikeArguments,
    content: SCShareableContent
) throws -> (SCContentFilter, SpikeTarget) {
    switch arguments.targetKind {
    case .display, .displayRegion:
        let display = arguments.displayID.flatMap { id in content.displays.first { $0.displayID == id } }
            ?? content.displays.sorted { $0.displayID < $1.displayID }.first
        guard let display else { throw SpikeRunError.targetUnavailable("no display is shareable") }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let scale: Double? = if #available(macOS 14.0, *) {
            Double(filter.pointPixelScale)
        } else {
            nil
        }
        return (
            filter,
            SpikeTarget(
                kind: arguments.targetKind,
                nativeID: display.displayID,
                title: nil,
                ownerPID: nil,
                ownerBundleID: nil,
                sourceSize: SpikeSize(width: display.width, height: display.height),
                scaleFactor: scale
            )
        )
    case .window:
        let candidates = content.windows.filter { window in
            guard window.windowLayer == 0, window.frame.width >= 64, window.frame.height >= 64 else {
                return false
            }
            if let windowID = arguments.windowID, window.windowID != windowID { return false }
            if let ownerPID = arguments.ownerPID, window.owningApplication?.processID != ownerPID {
                return false
            }
            if let title = arguments.titleContains?.lowercased(),
               !(window.title ?? "").lowercased().contains(title)
            {
                return false
            }
            return true
        }
        let window = candidates.sorted { left, right in
            left.frame.width * left.frame.height > right.frame.width * right.frame.height
        }.first
        guard let window else { throw SpikeRunError.targetUnavailable("requested window is not shareable") }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale: Double? = if #available(macOS 14.0, *) {
            Double(filter.pointPixelScale)
        } else {
            nil
        }
        return (
            filter,
            SpikeTarget(
                kind: .window,
                nativeID: window.windowID,
                title: window.title,
                ownerPID: window.owningApplication?.processID,
                ownerBundleID: window.owningApplication?.bundleIdentifier,
                sourceSize: SpikeSize(
                    width: Int(window.frame.width * CGFloat(scale ?? 1)),
                    height: Int(window.frame.height * CGFloat(scale ?? 1))
                ),
                scaleFactor: scale
            )
        )
    }
}

private func runCapture(
    _ arguments: SpikeArguments,
    permissionGranted: Bool,
    permissionRequestAttempted: Bool
) async throws -> SpikeResult {
    let directory = try spikeRunDirectory(arguments.runID)
    let content = try await SCShareableContent.excludingDesktopWindows(
        false,
        onScreenWindowsOnly: false
    )
    let (filter, target) = try selectedTarget(arguments, content: content)
    let configuration = SCStreamConfiguration()
    configuration.width = arguments.width
    configuration.height = arguments.height
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(arguments.fps))
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.scalesToFit = true
    if #available(macOS 14.0, *) { configuration.preservesAspectRatio = true }
    configuration.showsCursor = arguments.cursor
    configuration.queueDepth = 6
    configuration.capturesAudio = arguments.audio
    configuration.sampleRate = 48_000
    configuration.channelCount = 2
    configuration.excludesCurrentProcessAudio = true
    if arguments.targetKind == .displayRegion {
        let frame = target.sourceSize
        configuration.sourceRect = CGRect(
            x: Double(frame.width) * 0.125,
            y: Double(frame.height) * 0.125,
            width: Double(frame.width) * 0.75,
            height: Double(frame.height) * 0.75
        )
    }

    let startedUptimeNS = DispatchTime.now().uptimeNanoseconds
    let audioURL = directory.appendingPathComponent("system-audio.m4a")
    let audioWriter = arguments.audio ? try AudioStemWriter(outputURL: audioURL) : nil
    let collector = CaptureCollector(
        fps: arguments.fps,
        startedUptimeNS: startedUptimeNS,
        audioWriter: audioWriter
    )
    let stream = SCStream(filter: filter, configuration: configuration, delegate: collector)
    let videoQueue = DispatchQueue(label: "com.storycapture.spike.screen", qos: .userInitiated)
    let audioQueue = DispatchQueue(label: "com.storycapture.spike.audio", qos: .userInitiated)
    try stream.addStreamOutput(collector, type: .screen, sampleHandlerQueue: videoQueue)
    if arguments.audio {
        try stream.addStreamOutput(collector, type: .audio, sampleHandlerQueue: audioQueue)
    }

    var recordingObserver: AnyObject?
    var recordingOutput: AnyObject?
    let segmentURL = directory.appendingPathComponent("backend-segment.mp4")
    if arguments.transport == .backendSegment {
        guard #available(macOS 15.0, *) else { throw SpikeRunError.backendSegmentUnavailable }
        try? FileManager.default.removeItem(at: segmentURL)
        let outputConfiguration = SCRecordingOutputConfiguration()
        outputConfiguration.outputURL = segmentURL
        outputConfiguration.videoCodecType = .h264
        outputConfiguration.outputFileType = .mp4
        let observer = RecordingObserver()
        let output = SCRecordingOutput(configuration: outputConfiguration, delegate: observer)
        try stream.addRecordingOutput(output)
        recordingObserver = observer
        recordingOutput = output
    }

    try await stream.startCapture()
    try await Task.sleep(nanoseconds: UInt64(arguments.durationMS) * 1_000_000)
    if #available(macOS 15.0, *),
       let output = recordingOutput as? SCRecordingOutput
    {
        try stream.removeRecordingOutput(output)
    }
    try await stream.stopCapture()
    _ = recordingOutput
    let audioFinalization = await audioWriter?.finish()
        ?? AudioFinalization(path: nil, bytes: nil, status: "not_requested")
    if arguments.transport == .backendSegment {
        for _ in 0 ..< 40 {
            guard #available(macOS 15.0, *),
                  let observer = recordingObserver as? RecordingObserver,
                  observer.status != "completed",
                  !observer.status.hasPrefix("failed:")
            else { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }
    let snapshot = collector.snapshot()
    let segmentBytes = (try? FileManager.default.attributesOfItem(atPath: segmentURL.path)[.size]
        as? NSNumber)?.int64Value
    let recordingStatus: String
    if #available(macOS 15.0, *), let observer = recordingObserver as? RecordingObserver {
        recordingStatus = observer.status
    } else {
        recordingStatus = arguments.transport == .backendSegment ? "unavailable" : "not_requested"
    }
    let endedUptimeNS = DispatchTime.now().uptimeNanoseconds
    return SpikeResult(
        fixtureID: arguments.runID,
        target: target,
        targetKind: arguments.targetKind,
        transport: arguments.transport,
        requestedSize: SpikeSize(width: arguments.width, height: arguments.height),
        requestedFPS: arguments.fps,
        durationMS: arguments.durationMS,
        cursorIncluded: arguments.cursor,
        permissionPreflightGranted: permissionGranted,
        permissionRequestAttempted: permissionRequestAttempted,
        frameCount: snapshot.frameCount,
        firstNativePTSNS: snapshot.firstPTSNS,
        lastNativePTSNS: snapshot.lastPTSNS,
        firstFrameDelayMS: snapshot.firstFrameDelayMS,
        nonMonotonicPTS: snapshot.nonMonotonicPTS,
        droppedOrMissingFrames: snapshot.droppedOrMissingFrames,
        maxFrameGapMS: snapshot.maxFrameGapMS,
        formatChangeCount: snapshot.formatChangeCount,
        observedFormats: snapshot.observedFormats,
        frameStatusCounts: snapshot.frameStatusCounts,
        audio: SpikeAudioMetrics(
            requested: arguments.audio,
            bufferCount: snapshot.audioBufferCount,
            sampleCount: snapshot.audioSampleCount,
            firstPTSNS: snapshot.audioFirstPTSNS,
            lastPTSNS: snapshot.audioLastPTSNS,
            nonMonotonicPTS: snapshot.audioNonMonotonicPTS,
            zeroValuedBufferCount: snapshot.audioZeroBufferCount,
            sampleRate: snapshot.audioSampleRate,
            channelCount: snapshot.audioChannelCount,
            firstSampleDelayMS: snapshot.firstAudioDelayMS,
            outputPath: audioFinalization.path,
            outputBytes: audioFinalization.bytes,
            writerStatus: audioFinalization.status
        ),
        backendSegmentPath: FileManager.default.fileExists(atPath: segmentURL.path)
            ? segmentURL.path
            : nil,
        backendSegmentBytes: segmentBytes,
        recordingOutputStatus: recordingStatus,
        terminalReason: snapshot.terminalReason,
        startedUptimeNS: startedUptimeNS,
        endedUptimeNS: endedUptimeNS,
        osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
        hardware: hardwareModel(),
        exactCommand: CommandLine.arguments
    )
}

private struct FixtureReady: Codable {
    let runID: String
    let pid: Int32
    let title: String
    let size: SpikeSize

    enum CodingKeys: String, CodingKey {
        case runID = "run_id"
        case pid
        case title
        case size
    }
}

@MainActor
private final class AnimatedFixtureView: NSView {
    private var phase = 0.0
    private var timer: Timer?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.phase += 0.025
                self?.needsDisplay = true
            }
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedRed: 0.035, green: 0.055, blue: 0.09, alpha: 1).setFill()
        dirtyRect.fill()
        let count = 18
        for index in 0 ..< count {
            let progress = (Double(index) / Double(count) + phase).truncatingRemainder(dividingBy: 1)
            let width = bounds.width * 0.12
            let x = progress * (bounds.width + width) - width
            let y = CGFloat(index % 6) * bounds.height / 6
            let rect = NSRect(x: x, y: y, width: width, height: bounds.height / 8)
            NSColor(
                calibratedHue: (Double(index) / Double(count) + phase * 0.2)
                    .truncatingRemainder(dividingBy: 1),
                saturation: 0.78,
                brightness: 0.94,
                alpha: 1
            ).setFill()
            NSBezierPath(roundedRect: rect, xRadius: 12, yRadius: 12).fill()
        }
        let label = "StoryCapture ScreenCaptureKit spike · \(Int(phase * 1000))"
        label.draw(
            at: NSPoint(x: 36, y: bounds.height - 64),
            withAttributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 24, weight: .semibold),
                .foregroundColor: NSColor.white,
            ]
        )
    }
}

@MainActor
private func runFixtureWindow(_ arguments: SpikeArguments) {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    let title = "StoryCapture Native Spike \(arguments.runID)"
    let rect = NSRect(x: 80, y: 80, width: arguments.width, height: arguments.height)
    let window = NSWindow(
        contentRect: rect,
        styleMask: [.titled, .closable, .resizable],
        backing: .buffered,
        defer: false
    )
    window.title = title
    window.contentView = AnimatedFixtureView(frame: NSRect(origin: .zero, size: rect.size))
    window.makeKeyAndOrderFront(nil)
    application.activate(ignoringOtherApps: true)
    try? emitSpikeMessage(
        type: "fixture_ready",
        payload: FixtureReady(
            runID: arguments.runID,
            pid: getpid(),
            title: title,
            size: SpikeSize(width: arguments.width, height: arguments.height)
        )
    )
    application.run()
}

@main
struct StoryCaptureMacCaptureSpike {
    static func main() async {
        let arguments: SpikeArguments
        do {
            arguments = try SpikeArguments.parse(CommandLine.arguments)
        } catch {
            let failure = SpikeFailure(
                reason: "invalid_arguments",
                detail: error.localizedDescription,
                permissionPreflightGranted: false,
                permissionRequestAttempted: false,
                exactCommand: CommandLine.arguments
            )
            try? emitSpikeMessage(type: "failure", payload: failure)
            exit(2)
        }

        if arguments.fixtureWindow {
            await MainActor.run { runFixtureWindow(arguments) }
            return
        }

        _ = await MainActor.run {
            NSApplication.shared.setActivationPolicy(.prohibited)
        }
        var permissionGranted = CGPreflightScreenCaptureAccess()
        let permissionRequestAttempted = arguments.requestPermission && !permissionGranted
        if permissionRequestAttempted {
            permissionGranted = CGRequestScreenCaptureAccess()
        }
        do {
            let result = try await runCapture(
                arguments,
                permissionGranted: permissionGranted,
                permissionRequestAttempted: permissionRequestAttempted
            )
            let directory = try spikeRunDirectory(arguments.runID)
            let resultData = try spikeJSONData(type: "result", payload: result)
            try resultData.write(to: directory.appendingPathComponent("result.json"), options: .atomic)
            try emitSpikeMessage(type: "result", payload: result)
        } catch {
            let reason: String
            if !permissionGranted {
                reason = "permission_denied"
            } else if let spikeError = error as? SpikeRunError {
                switch spikeError {
                case .invalidArgument:
                    reason = "invalid_arguments"
                case .targetUnavailable:
                    reason = "target_unavailable"
                case .backendSegmentUnavailable:
                    reason = "backend_segment_unavailable"
                case .audioWriter:
                    reason = "audio_writer_failed"
                }
            } else {
                reason = "capture_failed"
            }
            let failure = SpikeFailure(
                reason: reason,
                detail: error.localizedDescription,
                permissionPreflightGranted: permissionGranted,
                permissionRequestAttempted: permissionRequestAttempted,
                exactCommand: CommandLine.arguments
            )
            if let directory = try? spikeRunDirectory(arguments.runID),
               let data = try? spikeJSONData(type: "failure", payload: failure)
            {
                try? data.write(to: directory.appendingPathComponent("result.json"), options: .atomic)
            }
            try? emitSpikeMessage(type: "failure", payload: failure)
            exit(3)
        }
    }
}
