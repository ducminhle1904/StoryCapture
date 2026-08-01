import AVFoundation
import Foundation

final class RecordingV4Microphone: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let writer: RecordingV4Writer
    private let lock = NSLock()
    private var running = false
    private var converter: AVAudioConverter?
    private var outputFormat: AVAudioFormat?

    init(writer: RecordingV4Writer) {
        self.writer = writer
    }

    func start() throws {
        lock.lock()
        defer { lock.unlock() }
        guard !running else { throw HelperFailureCode.contractMismatch }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            throw HelperFailureCode.audioDeviceUnavailable
        }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate.isFinite,
              format.sampleRate > 0,
              format.channelCount > 0 else {
            throw HelperFailureCode.audioFormatInvalid
        }
        guard let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 48_000,
            channels: 2,
            interleaved: false
        ), let converter = AVAudioConverter(from: format, to: outputFormat) else {
            throw HelperFailureCode.audioFormatInvalid
        }
        self.outputFormat = outputFormat
        self.converter = converter
        try writer.configureAudio(
            role: .microphone,
            sampleRate: 48_000,
            channels: 2
        )
        input.installTap(onBus: 0, bufferSize: 960, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            do {
                try writer.appendMicrophone(try convert(buffer))
            } catch {
                writer.fail(error)
            }
        }
        engine.prepare()
        do {
            try engine.start()
            running = true
        } catch {
            input.removeTap(onBus: 0)
            throw HelperFailureCode.audioDeviceUnavailable
        }
    }

    func stop() {
        lock.lock()
        defer { lock.unlock() }
        guard running else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        converter = nil
        outputFormat = nil
        running = false
    }

    private func convert(_ input: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        guard let converter, let outputFormat else { throw HelperFailureCode.audioFormatInvalid }
        let ratio = outputFormat.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * ratio)) + 1
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
            throw HelperFailureCode.audioFormatInvalid
        }
        var supplied = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return input
        }
        guard status != .error, conversionError == nil, output.frameLength > 0 else {
            throw HelperFailureCode.audioFormatInvalid
        }
        return output
    }

    deinit { stop() }
}
