import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import ScreenCaptureKit

public final class ControlChannel: @unchecked Sendable {
    private let lock = NSLock()
    private let handle: FileHandle

    public init(handle: FileHandle = .standardOutput) {
        self.handle = handle
    }

    public func send(_ value: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(value),
              var data = try? JSONSerialization.data(withJSONObject: value) else {
            return
        }
        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        try? handle.write(contentsOf: data)
    }

    public func reply(_ requestID: String, event: String, data: [String: Any] = [:]) {
        send([
            "version": helperProtocolVersion,
            "request_id": requestID,
            "event": event,
            "ok": true,
            "data": data,
        ])
    }

    public func fail(_ requestID: String?, code: HelperFailureCode, message: String) {
        var value: [String: Any] = [
            "version": helperProtocolVersion,
            "event": "error",
            "ok": false,
            "code": code.rawValue,
            "message": message,
        ]
        if let requestID { value["request_id"] = requestID }
        send(value)
    }
}

public final class BinaryPacketChannel: @unchecked Sendable {
    private let lock = NSLock()
    private let handle: FileHandle

    public init(fileDescriptor: Int32 = 3) {
        handle = FileHandle(fileDescriptor: fileDescriptor, closeOnDealloc: false)
    }

    public func write(header: NativePacketHeader, bytes: UnsafeRawBufferPointer) throws {
        let headerData = header.encode()
        let payload = Data(bytesNoCopy: UnsafeMutableRawPointer(mutating: bytes.baseAddress!),
                           count: bytes.count,
                           deallocator: .none)
        lock.lock()
        defer { lock.unlock() }
        try handle.write(contentsOf: headerData)
        try handle.write(contentsOf: payload)
    }
}

public struct NativeProbeResult: Sendable {
    public let identity: ResolvedTargetIdentity
    public let measuredFPSNumerator: Int?
    public let measuredFPSDenominator: Int?
    public let sourcePresentations: Int
    public let sequenceGaps: Int
    public let staleReuses: Int
    public let probeDurationMS: Int
}

private struct ResolvedScreenTarget {
    let filter: SCContentFilter
    let identity: ResolvedTargetIdentity
}

private final class RateProbe: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var timestamps: [UInt64] = []
    private var stoppedError: Error?

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock()
        stoppedError = error
        lock.unlock()
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .screen,
              sampleBuffer.isValid,
              sampleBuffer.isCompleteFrame,
              let pts = sampleBuffer.nativeDisplayPTSUS else {
            return
        }
        lock.lock()
        timestamps.append(pts)
        lock.unlock()
    }

    func result(identity: ResolvedTargetIdentity, durationMS: Int) throws -> NativeProbeResult {
        lock.lock()
        defer { lock.unlock() }
        if let stoppedError { throw stoppedError }
        var gaps = 0
        var stale = 0
        for pair in zip(timestamps, timestamps.dropFirst()) {
            if pair.1 <= pair.0 {
                stale += 1
                continue
            }
            let delta = pair.1 - pair.0
            if delta > 25_000 {
                gaps += max(1, Int((Double(delta) / (1_000_000 / 60)).rounded()) - 1)
            }
        }
        var numerator: Int?
        var denominator: Int?
        if timestamps.count > 1, let first = timestamps.first, let last = timestamps.last, last > first {
            let measured = Double(timestamps.count - 1) * 1_000_000 / Double(last - first)
            if abs(measured - 60) <= 0.5, gaps == 0, stale == 0 {
                numerator = 60
                denominator = 1
            } else {
                numerator = Int((measured * 1_000).rounded())
                denominator = 1_000
            }
        }
        return NativeProbeResult(
            identity: identity,
            measuredFPSNumerator: numerator,
            measuredFPSDenominator: denominator,
            sourcePresentations: timestamps.count,
            sequenceGaps: gaps,
            staleReuses: stale,
            probeDurationMS: durationMS
        )
    }
}

private final class CaptureStreamOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let control: ControlChannel
    private let packets: BinaryPacketChannel
    private let dynamicSizePolicy: DynamicSizePolicy
    private let stateLock = NSLock()
    private var lifecycle = CaptureLifecycle()
    private var videoSequence: UInt64 = 0
    private var audioSequence: UInt64 = 0
    private var lastVideoPTSUS: UInt64?
    private var lastAudioPTSUS: UInt64?
    private var initialContentSize: CGSize?
    private var failure: HelperFailureCode?

    init(
        control: ControlChannel,
        packets: BinaryPacketChannel,
        dynamicSizePolicy: DynamicSizePolicy
    ) {
        self.control = control
        self.packets = packets
        self.dynamicSizePolicy = dynamicSizePolicy
    }

    func start() throws {
        stateLock.lock()
        defer { stateLock.unlock() }
        try lifecycle.start()
    }

    func pause() throws {
        stateLock.lock()
        defer { stateLock.unlock() }
        try lifecycle.pause()
    }

    func resume() throws {
        stateLock.lock()
        defer { stateLock.unlock() }
        try lifecycle.resume()
        lastVideoPTSUS = nil
        lastAudioPTSUS = nil
    }

    func stop() throws {
        stateLock.lock()
        defer { stateLock.unlock() }
        if lifecycle.state == .stopped { return }
        try lifecycle.stop()
    }

    func stats() -> (video: UInt64, audio: UInt64, failure: HelperFailureCode?) {
        stateLock.lock()
        defer { stateLock.unlock() }
        return (videoSequence, audioSequence, failure)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail(.targetLost, "ScreenCaptureKit stopped: \(error.localizedDescription)")
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard sampleBuffer.isValid else { return }
        switch outputType {
        case .screen:
            writeVideo(sampleBuffer)
        case .audio:
            writeAudio(sampleBuffer)
        @unknown default:
            break
        }
    }

    private func writeVideo(_ sampleBuffer: CMSampleBuffer) {
        stateLock.lock()
        guard lifecycle.state == .running, failure == nil else {
            stateLock.unlock()
            return
        }
        stateLock.unlock()
        guard sampleBuffer.isCompleteFrame else {
            fail(.submittedFrameDropped, "ScreenCaptureKit did not commit a complete source frame")
            return
        }
        if dynamicSizePolicy == .failOnChange, let size = sampleBuffer.contentSize {
            stateLock.lock()
            let initial = initialContentSize
            if initial == nil { initialContentSize = size }
            stateLock.unlock()
            if let initial,
               (abs(size.width - initial.width) > 1 || abs(size.height - initial.height) > 1) {
                fail(.targetChanged, "captured target dimensions changed during a Strict session")
                return
            }
        }
        guard let imageBuffer = sampleBuffer.imageBuffer,
              CVPixelBufferGetPixelFormatType(imageBuffer) == kCVPixelFormatType_32BGRA,
              let pts = sampleBuffer.nativeDisplayPTSUS else {
            fail(.contractMismatch, "ScreenCaptureKit produced a non-BGRA frame or invalid timestamp")
            return
        }
        stateLock.lock()
        if let lastVideoPTSUS {
            let delta = pts > lastVideoPTSUS ? pts - lastVideoPTSUS : 0
            if delta < 13_000 || delta > 20_000 {
                stateLock.unlock()
                fail(.sourceRateMismatch, "ScreenCaptureKit source cadence was not exact 60/1")
                return
            }
        }
        videoSequence += 1
        let sequence = videoSequence
        lastVideoPTSUS = pts
        stateLock.unlock()

        CVPixelBufferLockBaseAddress(imageBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(imageBuffer, .readOnly) }
        guard let baseAddress = CVPixelBufferGetBaseAddress(imageBuffer) else {
            fail(.contractMismatch, "ScreenCaptureKit frame has no pixel base address")
            return
        }
        let width = CVPixelBufferGetWidth(imageBuffer)
        let height = CVPixelBufferGetHeight(imageBuffer)
        let stride = CVPixelBufferGetBytesPerRow(imageBuffer)
        let bytes = UnsafeRawBufferPointer(start: baseAddress, count: stride * height)
        do {
            try packets.write(
                header: NativePacketHeader(
                    kind: .videoBGRA,
                    sequence: sequence,
                    nativePTSUS: pts,
                    width: UInt32(width),
                    height: UInt32(height),
                    stride: UInt32(stride),
                    format: 1,
                    payloadBytes: UInt64(bytes.count)
                ),
                bytes: bytes
            )
        } catch {
            fail(.backendUnavailable, "native frame channel failed: \(error.localizedDescription)")
        }
    }

    private func writeAudio(_ sampleBuffer: CMSampleBuffer) {
        stateLock.lock()
        guard lifecycle.state == .running, failure == nil else {
            stateLock.unlock()
            return
        }
        guard let pts = sampleBuffer.nativeDisplayPTSUS,
              let format = sampleBuffer.formatDescription,
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
              let block = CMSampleBufferGetDataBuffer(sampleBuffer) else {
            stateLock.unlock()
            fail(.contractMismatch, "ScreenCaptureKit audio packet has no linear PCM payload")
            return
        }
        if let lastAudioPTSUS, pts <= lastAudioPTSUS {
            stateLock.unlock()
            fail(.contractMismatch, "ScreenCaptureKit produced a non-monotonic audio timestamp")
            return
        }
        audioSequence += 1
        let sequence = audioSequence
        lastAudioPTSUS = pts
        stateLock.unlock()
        var lengthAtOffset = 0
        var totalLength = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            block,
            atOffset: 0,
            lengthAtOffsetOut: &lengthAtOffset,
            totalLengthOut: &totalLength,
            dataPointerOut: &pointer
        ) == kCMBlockBufferNoErr, let pointer else {
            fail(.contractMismatch, "ScreenCaptureKit audio packet could not be mapped")
            return
        }
        let bytes = UnsafeRawBufferPointer(start: pointer, count: totalLength)
        do {
            try packets.write(
                header: NativePacketHeader(
                    kind: .systemAudioLPCM,
                    sequence: sequence,
                    nativePTSUS: pts,
                    width: UInt32(asbd.mSampleRate.rounded()),
                    height: asbd.mChannelsPerFrame,
                    stride: asbd.mBytesPerFrame,
                    format: asbd.mFormatID,
                    payloadBytes: UInt64(totalLength),
                    flags: UInt64(asbd.mFormatFlags)
                ),
                bytes: bytes
            )
        } catch {
            fail(.backendUnavailable, "native audio channel failed: \(error.localizedDescription)")
        }
    }

    private func fail(_ code: HelperFailureCode, _ message: String) {
        stateLock.lock()
        guard failure == nil else {
            stateLock.unlock()
            return
        }
        failure = code
        lifecycle.fail()
        stateLock.unlock()
        control.fail(nil, code: code, message: message)
    }
}

public final class ScreenCaptureHelperController: @unchecked Sendable {
    private let control: ControlChannel
    private let packets: BinaryPacketChannel
    private let videoQueue = DispatchQueue(label: "com.storycapture.capture.screen", qos: .userInteractive)
    private let audioQueue = DispatchQueue(label: "com.storycapture.capture.audio", qos: .userInteractive)
    private var stream: SCStream?
    private var output: CaptureStreamOutput?
    private var activeTarget: HelperTarget?
    private var activeIdentity: ResolvedTargetIdentity?
    private var sessionID: String?

    public init(control: ControlChannel, packets: BinaryPacketChannel) {
        self.control = control
        self.packets = packets
    }

    public func handle(_ command: HelperCommand) async -> Bool {
        guard command.version == helperProtocolVersion else {
            control.fail(command.requestID, code: .contractMismatch, message: "helper protocol version must be 2")
            return true
        }
        do {
            switch command.command {
            case .hello:
                control.reply(command.requestID, event: "hello", data: capabilities())
            case .probe:
                let payload = try requiredPayload(command)
                let result = try await probe(payload)
                control.reply(command.requestID, event: "probe", data: probeData(result))
            case .start:
                try await start(command)
                control.reply(command.requestID, event: "started", data: identityData())
            case .pause:
                guard let output else { throw HelperFailureCode.contractMismatch }
                try output.pause()
                control.reply(command.requestID, event: "paused")
            case .resume:
                guard let output else { throw HelperFailureCode.contractMismatch }
                try await validateActiveTarget()
                try output.resume()
                control.reply(command.requestID, event: "resumed")
            case .stop:
                let stats = try await stop()
                control.reply(command.requestID, event: "stopped", data: stats)
            case .shutdown:
                if stream != nil { _ = try await stop() }
                control.reply(command.requestID, event: "shutdown")
                return false
            }
        } catch let code as HelperFailureCode {
            control.fail(command.requestID, code: code, message: code.rawValue)
        } catch {
            control.fail(command.requestID, code: .backendUnavailable, message: error.localizedDescription)
        }
        return true
    }

    private func capabilities() -> [String: Any] {
        [
            "backend_id": helperBackendID,
            "backend_version": helperBackendVersion,
            "platform": "darwin",
            "arch": architecture(),
            "supports_native_timestamps": true,
            "supports_source_sequences": true,
            "supports_physical_pixels": true,
            "supports_cursor_policy": true,
            "supports_pause_resume": true,
        ]
    }

    private func requiredPayload(_ command: HelperCommand) throws -> HelperCommandPayload {
        guard let payload = command.payload,
              payload.outputWidth ?? 0 > 0,
              payload.outputWidth ?? 0 <= 16_384,
              payload.outputHeight ?? 0 > 0,
              payload.outputHeight ?? 0 <= 16_384,
              payload.expectedLogicalWidth ?? 0 > 0,
              payload.expectedLogicalWidth ?? 0 <= 16_384,
              payload.expectedLogicalHeight ?? 0 > 0,
              payload.expectedLogicalHeight ?? 0 <= 16_384,
              payload.target != nil else {
            throw HelperFailureCode.contractMismatch
        }
        return payload
    }

    private func probe(_ payload: HelperCommandPayload) async throws -> NativeProbeResult {
        guard stream == nil else { throw HelperFailureCode.contractMismatch }
        guard CGPreflightScreenCaptureAccess() else { throw HelperFailureCode.permissionDenied }
        let resolved = try await resolve(payload.target!)
        try validateDimensions(resolved.identity, payload: payload)
        let configuration = try streamConfiguration(payload)
        configuration.showsCursor = false
        configuration.capturesAudio = false
        let delegate = RateProbe()
        let probeStream = SCStream(filter: resolved.filter, configuration: configuration, delegate: delegate)
        try probeStream.addStreamOutput(delegate, type: .screen, sampleHandlerQueue: videoQueue)
        try await probeStream.startCapture()
        let durationMS = min(10_000, max(1_000, payload.probeDurationMS ?? 5_000))
        try await Task.sleep(nanoseconds: UInt64(durationMS) * 1_000_000)
        try await probeStream.stopCapture()
        return try delegate.result(identity: resolved.identity, durationMS: durationMS)
    }

    private func start(_ command: HelperCommand) async throws {
        guard stream == nil, let requestedSessionID = command.sessionID, !requestedSessionID.isEmpty else {
            throw HelperFailureCode.contractMismatch
        }
        guard CGPreflightScreenCaptureAccess() else { throw HelperFailureCode.permissionDenied }
        let payload = try requiredPayload(command)
        let resolved = try await resolve(payload.target!)
        try validateDimensions(resolved.identity, payload: payload)
        let configuration = try streamConfiguration(payload)
        let output = CaptureStreamOutput(
            control: control,
            packets: packets,
            dynamicSizePolicy: payload.dynamicSizePolicy ?? .failOnChange
        )
        let stream = SCStream(filter: resolved.filter, configuration: configuration, delegate: output)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: videoQueue)
        if configuration.capturesAudio {
            try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: audioQueue)
        }
        try output.start()
        do {
            try await stream.startCapture()
        } catch {
            output.stopIfPossible()
            throw error
        }
        self.stream = stream
        self.output = output
        activeTarget = payload.target
        activeIdentity = resolved.identity
        sessionID = requestedSessionID
    }

    private func stop() async throws -> [String: Any] {
        guard let stream, let output else { throw HelperFailureCode.contractMismatch }
        try await stream.stopCapture()
        try output.stop()
        let stats = output.stats()
        self.stream = nil
        self.output = nil
        activeTarget = nil
        activeIdentity = nil
        sessionID = nil
        return [
            "video_packets": stats.video,
            "audio_packets": stats.audio,
            "failure_code": stats.failure?.rawValue ?? NSNull(),
        ]
    }

    private func validateActiveTarget() async throws {
        guard let activeTarget, let activeIdentity else { throw HelperFailureCode.contractMismatch }
        let current = try await resolve(activeTarget)
        guard current.identity.fingerprint == activeIdentity.fingerprint else {
            throw HelperFailureCode.targetChanged
        }
    }

    private func streamConfiguration(_ payload: HelperCommandPayload) throws -> SCStreamConfiguration {
        guard let width = payload.outputWidth,
              let height = payload.outputHeight,
              width > 0,
              height > 0 else {
            throw HelperFailureCode.contractMismatch
        }
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        configuration.queueDepth = 8
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = payload.showsCursor ?? true
        configuration.capturesAudio = payload.capturesSystemAudio ?? false
        if configuration.capturesAudio {
            configuration.sampleRate = 48_000
            configuration.channelCount = 2
            configuration.excludesCurrentProcessAudio = true
        }
        return configuration
    }

    private func resolve(_ target: HelperTarget) async throws -> ResolvedScreenTarget {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        switch target.kind {
        case .display:
            let candidates = content.displays.map {
                DisplayIdentityCandidate(
                    displayID: $0.displayID,
                    logicalWidth: Int($0.frame.width.rounded()),
                    logicalHeight: Int($0.frame.height.rounded()),
                    physicalWidth: CGDisplayPixelsWide($0.displayID),
                    physicalHeight: CGDisplayPixelsHigh($0.displayID),
                    originX: Int($0.frame.origin.x.rounded()),
                    originY: Int($0.frame.origin.y.rounded())
                )
            }
            let identity = try TargetIdentityResolver.display(target: target, candidates: candidates)
            guard let display = content.displays.first(where: { $0.displayID == target.displayID }) else {
                throw HelperFailureCode.targetMissing
            }
            return ResolvedScreenTarget(
                filter: SCContentFilter(display: display, excludingApplications: [], exceptingWindows: []),
                identity: identity
            )
        case .window:
            let candidates = content.windows.compactMap { window -> WindowIdentityCandidate? in
                guard let application = window.owningApplication else { return nil }
                return WindowIdentityCandidate(
                    windowID: window.windowID,
                    ownerPID: application.processID,
                    ownerBundleID: application.bundleIdentifier,
                    title: window.title ?? "",
                    width: Int(window.frame.width.rounded()),
                    height: Int(window.frame.height.rounded())
                )
            }
            guard let window = content.windows.first(where: {
                $0.windowID == target.windowID &&
                    $0.owningApplication?.processID == target.ownerPID &&
                    $0.owningApplication?.bundleIdentifier == target.ownerBundleID
            }) else {
                _ = try TargetIdentityResolver.window(target: target, candidates: candidates, scaleFactor: 1)
                throw HelperFailureCode.targetMissing
            }
            let scale = backingScaleFactor(for: window.frame)
            let identity = try TargetIdentityResolver.window(target: target, candidates: candidates, scaleFactor: scale)
            return ResolvedScreenTarget(filter: SCContentFilter(desktopIndependentWindow: window), identity: identity)
        }
    }

    private func validateDimensions(
        _ identity: ResolvedTargetIdentity,
        payload: HelperCommandPayload
    ) throws {
        guard identity.logicalWidth == payload.expectedLogicalWidth,
              identity.logicalHeight == payload.expectedLogicalHeight,
              identity.physicalWidth == payload.outputWidth,
              identity.physicalHeight == payload.outputHeight else {
            throw HelperFailureCode.targetChanged
        }
    }

    private func backingScaleFactor(for frame: CGRect) -> Double {
        let matchingScreen = NSScreen.screens.max { left, right in
            left.frame.intersection(frame).area < right.frame.intersection(frame).area
        }
        return Double(matchingScreen?.backingScaleFactor ?? 1)
    }

    private func probeData(_ result: NativeProbeResult) -> [String: Any] {
        var fps: Any = NSNull()
        if let numerator = result.measuredFPSNumerator,
           let denominator = result.measuredFPSDenominator {
            fps = ["numerator": numerator, "denominator": denominator]
        }
        return capabilities().merging([
            "permissions_granted": true,
            "hardware_fingerprint": hardwareFingerprint(),
            "target_identity": result.identity.fingerprint,
            "logical_width": result.identity.logicalWidth,
            "logical_height": result.identity.logicalHeight,
            "physical_width": result.identity.physicalWidth,
            "physical_height": result.identity.physicalHeight,
            "measured_fps": fps,
            "source_presentations": result.sourcePresentations,
            "sequence_gaps": result.sequenceGaps,
            "stale_reuses": result.staleReuses,
            "probe_duration_ms": result.probeDurationMS,
        ]) { _, new in new }
    }

    private func identityData() -> [String: Any] {
        guard let activeIdentity, let sessionID else { return [:] }
        return [
            "session_id": sessionID,
            "target_identity": activeIdentity.fingerprint,
            "logical_width": activeIdentity.logicalWidth,
            "logical_height": activeIdentity.logicalHeight,
            "physical_width": activeIdentity.physicalWidth,
            "physical_height": activeIdentity.physicalHeight,
        ]
    }

    private func architecture() -> String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x64"
        #else
        return "unknown"
        #endif
    }

    private func hardwareFingerprint() -> String {
        TargetIdentityResolver.digest(
            "macOS:\(ProcessInfo.processInfo.operatingSystemVersionString):\(architecture()):\(ProcessInfo.processInfo.processorCount)"
        )
    }
}

private extension CaptureStreamOutput {
    func stopIfPossible() {
        try? stop()
    }
}

private extension CMSampleBuffer {
    var nativeDisplayPTSUS: UInt64? {
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(
            self,
            createIfNecessary: false
        ) as? [[SCStreamFrameInfo: Any]],
        let displayTime = attachments.first?[.displayTime] as? UInt64 {
            var timebase = mach_timebase_info_data_t()
            guard mach_timebase_info(&timebase) == KERN_SUCCESS, timebase.denom != 0 else {
                return nil
            }
            let nanoseconds = Double(displayTime) * Double(timebase.numer) / Double(timebase.denom)
            guard nanoseconds.isFinite, nanoseconds >= 0 else { return nil }
            return UInt64((nanoseconds / 1_000).rounded())
        }
        return monotonicMicroseconds(CMSampleBufferGetPresentationTimeStamp(self))
    }

    var isCompleteFrame: Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
            self,
            createIfNecessary: false
        ) as? [[SCStreamFrameInfo: Any]],
        let rawStatus = attachments.first?[.status] as? Int,
        let status = SCFrameStatus(rawValue: rawStatus) else {
            return false
        }
        return status == .complete
    }

    var contentSize: CGSize? {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
            self,
            createIfNecessary: false
        ) as? [[SCStreamFrameInfo: Any]],
        let rect = attachments.first?[.contentRect] as? CGRect else {
            return nil
        }
        return rect.size
    }
}

private extension CGRect {
    var area: Double { max(0, width) * max(0, height) }
}
