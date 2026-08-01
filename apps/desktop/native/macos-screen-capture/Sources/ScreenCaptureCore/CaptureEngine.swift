import AppKit
import AVFoundation
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

    public func reply(
        _ requestID: String,
        event: String,
        data: [String: Any] = [:],
        version: Int = recordingV4ProtocolVersion
    ) {
        send([
            "version": version,
            "request_id": requestID,
            "event": event,
            "ok": true,
            "data": data,
        ])
    }

    public func fail(
        _ requestID: String?,
        code: HelperFailureCode,
        message: String,
        version: Int = recordingV4ProtocolVersion
    ) {
        var value: [String: Any] = [
            "version": version,
            "event": "error",
            "ok": false,
            "code": code.rawValue,
            "message": message,
        ]
        if let requestID { value["request_id"] = requestID }
        send(value)
    }
}

private final class RecordingV4StreamOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let control: ControlChannel
    private let writer: RecordingV4Writer
    private let lock = NSLock()
    private var lifecycle = CaptureLifecycle()
    private var failure: HelperFailureCode?
    private var videoSequence: UInt64 = 0
    private let microphone: RecordingV4Microphone?

    init(
        control: ControlChannel,
        writer: RecordingV4Writer,
        capturesMicrophone: Bool = false
    ) {
        self.control = control
        self.writer = writer
        microphone = capturesMicrophone ? RecordingV4Microphone(writer: writer) : nil
    }

    func start() throws {
        lock.lock()
        defer { lock.unlock() }
        try lifecycle.start()
        try microphone?.start()
    }

    func pause() throws {
        lock.lock()
        defer { lock.unlock() }
        try lifecycle.pause()
        try writer.pause()
    }

    func resume() throws {
        lock.lock()
        defer { lock.unlock() }
        try lifecycle.resume()
        try writer.resume()
    }

    func stop() throws {
        lock.lock()
        defer { lock.unlock() }
        if lifecycle.state == .stopped { return }
        try lifecycle.stop()
        microphone?.stop()
    }

    func waitForInitialSurface(timeoutMS: Int = 5_000) async throws {
        let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(timeoutMS) * 1_000_000
        while DispatchTime.now().uptimeNanoseconds < deadline {
            if writer.hasInitialSurface() { return }
            if let currentFailure = capturedFailure() { throw currentFailure }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw HelperFailureCode.backendUnavailable
    }

    func finish() async throws -> RecordingV4Result {
        try await writer.finish()
    }

    func cancel() {
        try? stop()
        microphone?.stop()
        writer.cancel()
    }

    private func capturedFailure() -> HelperFailureCode? {
        lock.lock()
        defer { lock.unlock() }
        return failure
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail(.targetLost, "ScreenCaptureKit stopped: \(error.localizedDescription)")
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard sampleBuffer.isValid else {
            return
        }
        lock.lock()
        let running = lifecycle.state == .running && failure == nil
        lock.unlock()
        guard running else { return }
        do {
            if outputType == .audio {
                try writer.appendSystemAudio(sampleBuffer)
                return
            }
            guard outputType == .screen,
                  sampleBuffer.isCompleteFrame,
                  let pixelBuffer = sampleBuffer.imageBuffer else { return }
            videoSequence += 1
            guard let timestampUS = sampleBuffer.nativeDisplayPTSUS else {
                throw HelperFailureCode.outputPTSInvalid
            }
            try writer.append(
                pixelBuffer,
                sourceSequence: videoSequence,
                sourceTimestampUS: timestampUS
            )
        } catch let code as HelperFailureCode {
            fail(code, code.rawValue)
        } catch {
            fail(.submittedFrameDropped, error.localizedDescription)
        }
    }

    private func fail(_ code: HelperFailureCode, _ message: String) {
        lock.lock()
        guard failure == nil else {
            lock.unlock()
            return
        }
        failure = code
        lifecycle.fail()
        lock.unlock()
        writer.fail(code)
        control.fail(
            nil,
            code: code,
            message: message,
            version: recordingV4ProtocolVersion
        )
    }
}

private struct ResolvedScreenTarget {
    let filter: SCContentFilter
    let identity: ResolvedTargetIdentity
}

public final class ScreenCaptureHelperController: @unchecked Sendable {
    private let control: ControlChannel
    private let videoQueue = DispatchQueue(label: "com.storycapture.capture.screen", qos: .userInteractive)
    private let audioQueue = DispatchQueue(label: "com.storycapture.capture.audio", qos: .userInteractive)
    private var stream: SCStream?
    private var recordingOutput: RecordingV4StreamOutput?
    private var activeTarget: HelperTarget?
    private var activeIdentity: ResolvedTargetIdentity?
    private var sessionID: String?

    public init(control: ControlChannel) {
        self.control = control
    }

    public func handle(_ command: HelperCommand) async -> Bool {
        guard command.version == recordingV4ProtocolVersion else {
            control.fail(
                command.requestID,
                code: .contractMismatch,
                message: "unsupported helper protocol version",
                version: recordingV4ProtocolVersion
            )
            return true
        }
        do {
            switch command.command {
            case .hello:
                control.reply(
                    command.requestID,
                    event: "hello",
                    data: capabilities(),
                    version: command.version
                )
            case .warmup:
                let payload = try requiredPayload(command)
                let data = try await warmup(payload)
                control.reply(
                    command.requestID,
                    event: "warmed-up",
                    data: data,
                    version: command.version
                )
            case .start:
                try await startRecording(command)
                control.reply(
                    command.requestID,
                    event: "started",
                    data: identityData(),
                    version: command.version
                )
            case .pause:
                guard let recordingOutput else {
                    throw HelperFailureCode.contractMismatch
                }
                try recordingOutput.pause()
                control.reply(command.requestID, event: "paused", version: command.version)
            case .resume:
                try await validateActiveTarget()
                guard let recordingOutput else {
                    throw HelperFailureCode.contractMismatch
                }
                try recordingOutput.resume()
                control.reply(command.requestID, event: "resumed", version: command.version)
            case .stop:
                let stats = try await stopRecording()
                control.reply(command.requestID, event: "stopped", data: stats, version: command.version)
            case .cancel:
                if stream != nil {
                    try await cancelRecording()
                }
                control.reply(command.requestID, event: "cancelled", version: command.version)
            case .shutdown:
                if stream != nil {
                    try await cancelRecording()
                }
                control.reply(command.requestID, event: "shutdown", version: command.version)
                return false
            }
        } catch let code as HelperFailureCode {
            control.fail(
                command.requestID,
                code: code,
                message: code.rawValue,
                version: command.version
            )
        } catch {
            control.fail(
                command.requestID,
                code: .helperUnavailable,
                message: error.localizedDescription,
                version: command.version
            )
        }
        return true
    }

    private func capabilities() -> [String: Any] {
        let hardwareEncoderAvailable = RecordingV4Writer.hardwareEncoderAvailable()
        return [
            "backend_id": helperBackendID,
            "backend_version": recordingV4BackendVersion,
            "platform": "darwin",
            "arch": architecture(),
            "supports_native_timestamps": true,
            "supports_source_sequences": true,
            "supports_physical_pixels": true,
            "supports_cursor_policy": true,
            "supports_pause_resume": true,
            "supports_hardware_h264": hardwareEncoderAvailable,
            "supports_cfr_held_frames": true,
            "supports_atomic_finalization": true,
            "encoder": ["id": "videotoolbox-h264", "hardware_accelerated": true],
            "contract_version": recordingV4ProtocolVersion,
            "profile": "verified_1080p60",
            "supports_monotonic_60hz_scheduler": true,
            "supports_frame_ledger": true,
            "supports_encoder_envelope": true,
            "supports_terminal_backpressure": true,
            "supports_shared_audio_clock": true,
            "supported_audio_roles": RecordingV4AudioRole.allCases.map(\.rawValue),
            "requires_exact_surface": ["physical_width": 1_920, "physical_height": 1_080],
        ]
    }

    private func warmup(_ payload: HelperCommandPayload) async throws -> [String: Any] {
        guard stream == nil else { throw HelperFailureCode.contractMismatch }
        guard CGPreflightScreenCaptureAccess() else { throw HelperFailureCode.permissionDenied }
        guard payload.outputWidth == 1_920,
              payload.outputHeight == 1_080,
              payload.expectedPhysicalWidth == 1_920,
              payload.expectedPhysicalHeight == 1_080,
              payload.fpsNumerator == 60,
              payload.fpsDenominator == 1,
              let target = payload.target else {
            throw HelperFailureCode.surfaceNot1080p
        }
        guard RecordingV4Writer.hardwareEncoderAvailable() else {
            throw HelperFailureCode.hardwareEncoderUnavailable
        }
        guard let envelope = payload.encoderEnvelope else {
            throw HelperFailureCode.contractMismatch
        }
        try envelope.validate()
        let resolved = try await resolve(target)
        try validateDimensions(resolved.identity, payload: payload)
        let requested = Set(payload.requestedAudioRoles ?? [])
        if requested.contains(.microphone) {
            let permission = AVCaptureDevice.authorizationStatus(for: .audio)
            guard permission == .authorized else { throw HelperFailureCode.audioDeviceUnavailable }
        }
        let calibrationDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("storycapture-v4-calibration-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: calibrationDirectory) }
        let configuration = try streamConfiguration(payload)
        configuration.capturesAudio = false
        configuration.showsCursor = false
        let calibrationWriter = try RecordingV4Writer(
            artifactPath: calibrationDirectory.appendingPathComponent("calibration.mp4").path,
            width: 1_920,
            height: 1_080,
            encoderEnvelope: envelope
        )
        let calibrationOutput = RecordingV4StreamOutput(
            control: control,
            writer: calibrationWriter
        )
        let calibrationStream = SCStream(
            filter: resolved.filter,
            configuration: configuration,
            delegate: calibrationOutput
        )
        try calibrationStream.addStreamOutput(
            calibrationOutput,
            type: .screen,
            sampleHandlerQueue: videoQueue
        )
        try calibrationOutput.start()
        do {
            try await calibrationStream.startCapture()
            try await calibrationOutput.waitForInitialSurface()
            try await Task.sleep(nanoseconds: 350_000_000)
            try await calibrationStream.stopCapture()
            try calibrationOutput.stop()
        } catch {
            calibrationOutput.cancel()
            try? await calibrationStream.stopCapture()
            throw HelperFailureCode.encoderWarmupFailed
        }
        let calibration: RecordingV4Result
        do {
            calibration = try await calibrationOutput.finish()
        } catch {
            throw HelperFailureCode.encoderWarmupFailed
        }
        let encoderEvidence = calibration.encoderEvidence
        return capabilities().merging([
            "permission_granted": true,
            "target_identity": resolved.identity.fingerprint,
            "physical_width": resolved.identity.physicalWidth,
            "physical_height": resolved.identity.physicalHeight,
            "requested_audio_roles": requested.map(\.rawValue).sorted(),
            "available_audio_roles": RecordingV4AudioRole.allCases.map(\.rawValue),
            "encoder": encoderEvidence.dictionary,
            "encoder_envelope": payload.encoderEnvelope.map { envelope in
                [
                    "source": envelope.source,
                    "encoder_id": envelope.encoderID,
                    "minimum_bitrate_bps": envelope.minimumBitrateBPS,
                    "target_bitrate_bps": envelope.targetBitrateBPS,
                    "maximum_bitrate_bps": envelope.maximumBitrateBPS,
                    "safety_headroom_ratio": envelope.safetyHeadroomRatio,
                ] as [String: Any]
            } ?? NSNull(),
        ]) { _, new in new }
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
              payload.expectedPhysicalWidth ?? 0 > 0,
              payload.expectedPhysicalWidth ?? 0 <= 16_384,
              payload.expectedPhysicalHeight ?? 0 > 0,
              payload.expectedPhysicalHeight ?? 0 <= 16_384,
              payload.target != nil else {
            throw HelperFailureCode.contractMismatch
        }
        return payload
    }

    private func startRecording(_ command: HelperCommand) async throws {
        guard stream == nil,
              let requestedSessionID = command.sessionID,
              !requestedSessionID.isEmpty else {
            throw HelperFailureCode.contractMismatch
        }
        guard CGPreflightScreenCaptureAccess() else { throw HelperFailureCode.permissionDenied }
        let payload = try requiredPayload(command)
        guard let artifactPath = payload.artifactPath,
              !artifactPath.isEmpty,
              payload.fpsNumerator == 60,
              payload.fpsDenominator == 1,
              let width = payload.outputWidth,
              let height = payload.outputHeight,
              let target = payload.target else {
            throw HelperFailureCode.contractMismatch
        }
        guard width == 1_920,
              height == 1_080,
              payload.expectedPhysicalWidth == 1_920,
              payload.expectedPhysicalHeight == 1_080,
              let encoderEnvelope = payload.encoderEnvelope else {
            throw HelperFailureCode.surfaceNot1080p
        }
        try encoderEnvelope.validate()
        if target.kind == .window {
            guard let mediaSourceID = target.mediaSourceID,
                  windowIDFromMediaSourceID(mediaSourceID) == target.windowID else {
                throw HelperFailureCode.contractMismatch
            }
        }
        let resolved = try await resolve(target)
        try validateDimensions(resolved.identity, payload: payload)
        let configuration = try streamConfiguration(payload)
        let requestedAudioRoles = Array(Set(payload.requestedAudioRoles ?? []))
        configuration.capturesAudio = requestedAudioRoles.contains(.system)
        let channel = control
        let failureHandler: @Sendable (HelperFailureCode, String) -> Void = { code, message in
            channel.fail(
                nil,
                code: code,
                message: message,
                version: recordingV4ProtocolVersion
            )
        }
        let writer = try RecordingV4Writer(
            artifactPath: artifactPath,
            width: width,
            height: height,
            fpsNumerator: payload.fpsNumerator ?? 60,
            fpsDenominator: payload.fpsDenominator ?? 1,
            encoderEnvelope: encoderEnvelope,
            requestedAudioRoles: requestedAudioRoles,
            terminalFailureHandler: failureHandler
        )
        let output = RecordingV4StreamOutput(
            control: control,
            writer: writer,
            capturesMicrophone: requestedAudioRoles.contains(.microphone)
        )
        let stream = SCStream(filter: resolved.filter, configuration: configuration, delegate: output)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: videoQueue)
        if configuration.capturesAudio {
            try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: audioQueue)
        }
        try output.start()
        do {
            try await stream.startCapture()
            try await output.waitForInitialSurface()
        } catch {
            try? output.stop()
            try? await stream.stopCapture()
            throw error
        }
        self.stream = stream
        recordingOutput = output
        activeTarget = target
        activeIdentity = resolved.identity
        sessionID = requestedSessionID
    }

    private func stopRecording() async throws -> [String: Any] {
        guard let stream, let output = recordingOutput else {
            throw HelperFailureCode.contractMismatch
        }
        try await stream.stopCapture()
        try output.stop()
        defer {
            self.stream = nil
            recordingOutput = nil
            activeTarget = nil
            activeIdentity = nil
            sessionID = nil
        }
        let result = try await output.finish()
        return result.dictionary
    }

    private func cancelRecording() async throws {
        guard let stream, let output = recordingOutput else {
            throw HelperFailureCode.contractMismatch
        }
        try await stream.stopCapture()
        output.cancel()
        self.stream = nil
        recordingOutput = nil
        activeTarget = nil
        activeIdentity = nil
        sessionID = nil
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
        configuration.capturesAudio = false
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
              identity.physicalWidth == payload.expectedPhysicalWidth,
              identity.physicalHeight == payload.expectedPhysicalHeight else {
            throw HelperFailureCode.targetChanged
        }
    }

    private func backingScaleFactor(for frame: CGRect) -> Double {
        let matchingScreen = NSScreen.screens.max { left, right in
            left.frame.intersection(frame).area < right.frame.intersection(frame).area
        }
        return Double(matchingScreen?.backingScaleFactor ?? 1)
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
