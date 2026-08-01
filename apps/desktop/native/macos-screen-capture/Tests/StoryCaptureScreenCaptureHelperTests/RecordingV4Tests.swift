import AVFoundation
import CoreVideo
import XCTest
@testable import ScreenCaptureCore

final class RecordingV4Tests: XCTestCase {
    func testControllerRejectsUnknownProtocolFailClosed() async throws {
        let pipe = Pipe()
        let controller = ScreenCaptureHelperController(
            control: ControlChannel(handle: pipe.fileHandleForWriting),
            packets: BinaryPacketChannel()
        )
        _ = await controller.handle(.init(version: 5, requestID: "bad", command: .hello))
        try pipe.fileHandleForWriting.close()
        let data = try XCTUnwrap(try pipe.fileHandleForReading.readToEnd())
        let response = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(response["ok"] as? Bool, false)
        XCTAssertEqual(response["code"] as? String, "contract_mismatch")
    }

    func testProtocolV4DecodesEnvelopeAudioRolesAndNeverDowngrades() throws {
        let json = #"{"version":4,"request_id":"v4","command":"warmup","payload":{"target":{"kind":"window","windowID":42,"ownerPID":9,"ownerBundleID":"com.example.Editor","mediaSourceID":"window:42:0"},"outputWidth":1920,"outputHeight":1080,"expectedLogicalWidth":1920,"expectedLogicalHeight":1080,"expectedPhysicalWidth":1920,"expectedPhysicalHeight":1080,"fpsNumerator":60,"fpsDenominator":1,"requestedAudioRoles":["microphone","system"],"encoderEnvelope":{"source":"built_in_profile","encoder_id":"videotoolbox-h264","minimum_bitrate_bps":10000000,"target_bitrate_bps":20000000,"maximum_bitrate_bps":30000000,"safety_headroom_ratio":0.25}}}"#
        let command = try JSONDecoder().decode(HelperCommand.self, from: Data(json.utf8))
        XCTAssertEqual(command.version, recordingV4ProtocolVersion)
        XCTAssertEqual(command.command, .warmup)
        XCTAssertEqual(command.payload?.requestedAudioRoles, [.microphone, .system])
        XCTAssertEqual(command.payload?.encoderEnvelope?.targetBitrateBPS, 20_000_000)
        XCTAssertNotEqual(recordingV4ProtocolVersion, nativeMasterProtocolVersion)
    }

    func testExact60HzSlotsHoldsAndSourceLedger() throws {
        var scheduler = RecordingV4SlotScheduler()
        let epoch: UInt64 = 1_000_000
        try scheduler.ingest(.init(sequence: 7, timestampUS: 900_000), at: epoch) {
            slot, _ in (epoch + slot, epoch + slot + 1)
        }
        try scheduler.advance(to: epoch + 50_000) {
            slot, _ in (epoch + slot, epoch + slot + 1)
        }
        try scheduler.ingest(.init(sequence: 8, timestampUS: 949_000), at: epoch + 51_000) {
            slot, _ in (epoch + slot, epoch + slot + 1)
        }
        let evidence = try scheduler.finish(at: epoch + 100_000) {
            slot, _ in (epoch + slot, epoch + slot + 1)
        }

        XCTAssertEqual(evidence.ledger.count, 6)
        XCTAssertEqual(evidence.ledger.map(\.ptsUS), [0, 16_667, 33_333, 50_000, 66_667, 83_333])
        XCTAssertEqual(evidence.ledger.map(\.sourceSequence), [7, 7, 7, 8, 8, 8])
        XCTAssertNil(evidence.ledger[0].heldFromSlot)
        XCTAssertEqual(evidence.ledger[1].heldFromSlot, 0)
        XCTAssertNil(evidence.ledger[3].heldFromSlot)
        XCTAssertEqual(evidence.ledger[5].heldFromSlot, 3)
    }

    func testSourceUpdatesCountOnlyFramesUsedByCadence() throws {
        var scheduler = RecordingV4SlotScheduler()
        let epoch: UInt64 = 1_000_000
        try scheduler.ingest(.init(sequence: 1, timestampUS: epoch), at: epoch) { slot, _ in
            (epoch + slot, epoch + slot)
        }
        try scheduler.ingest(.init(sequence: 2, timestampUS: epoch + 1_000), at: epoch + 1_000) { slot, _ in
            (epoch + slot, epoch + slot)
        }
        try scheduler.ingest(.init(sequence: 3, timestampUS: epoch + 2_000), at: epoch + 2_000) { slot, _ in
            (epoch + slot, epoch + slot)
        }

        let evidence = try scheduler.finish(at: epoch + 34_000) { slot, _ in
            (epoch + slot, epoch + slot)
        }

        XCTAssertEqual(evidence.ledger.count, 2)
        XCTAssertEqual(evidence.ledger.map(\.sourceSequence), [1, 3])
        XCTAssertEqual(evidence.sourceUpdates, 2)
        XCTAssertEqual(evidence.sourceUpdates + UInt64(evidence.ledger.filter { $0.heldFromSlot != nil }.count), UInt64(evidence.ledger.count))
    }

    func testPauseRemovesWallTimeFromCadence() throws {
        var scheduler = RecordingV4SlotScheduler()
        let epoch: UInt64 = 10_000
        try scheduler.ingest(.init(sequence: 1, timestampUS: epoch), at: epoch) { slot, _ in
            (epoch + slot, epoch + slot)
        }
        try scheduler.pause(at: epoch + 20_000)
        try scheduler.resume(at: epoch + 120_000)
        let evidence = try scheduler.finish(at: epoch + 200_000) { slot, _ in
            (epoch + slot, epoch + slot)
        }
        XCTAssertEqual(evidence.activeDurationUS, 100_000)
        XCTAssertEqual(evidence.ledger.count, 6)
        XCTAssertEqual(evidence.pauseIntervals.count, 1)
        XCTAssertEqual(evidence.pauseIntervals[0].endedMonotonicUS - evidence.pauseIntervals[0].startedMonotonicUS, 100_000)
    }

    func testEncoderBackpressureIsTerminalAndRecordedAtSubmitBoundary() throws {
        var scheduler = RecordingV4SlotScheduler()
        XCTAssertThrowsError(
            try scheduler.ingest(.init(sequence: 1, timestampUS: 0), at: 1_000) { _, _ in
                throw HelperFailureCode.encoderBackpressure
            }
        ) { XCTAssertEqual($0 as? HelperFailureCode, .encoderBackpressure) }
        XCTAssertThrowsError(
            try scheduler.advance(to: 20_000) { _, _ in (0, 0) }
        ) { XCTAssertEqual($0 as? HelperFailureCode, .encoderBackpressure) }
    }

    func testRequestedAudioRolesUseContinuousSharedClockEvidence() throws {
        for role in RecordingV4AudioRole.allCases {
            var ledger = try RecordingV4AudioLedger(
                role: role,
                sampleRate: 48_000,
                channels: 2,
                syncToleranceUS: 2_000
            )
            try ledger.append(ptsUS: 0, frames: 480)
            try ledger.append(ptsUS: 10_000, frames: 480)
            let evidence = ledger.evidence(activeDurationUS: 20_000)
            XCTAssertEqual(evidence.role, role)
            XCTAssertEqual(evidence.continuityGaps, 0)
            XCTAssertEqual(evidence.endDriftUS, 0)
            XCTAssertEqual(evidence.syncToleranceUS, 2_000)
            XCTAssertTrue(evidence.pauseMappingValid)
            XCTAssertTrue(evidence.failureCodes.isEmpty)
        }
    }

    func testAudioGapFailsEvidence() throws {
        var ledger = try RecordingV4AudioLedger(role: .system, sampleRate: 48_000, channels: 2, syncToleranceUS: 1_000)
        try ledger.append(ptsUS: 0, frames: 480)
        try ledger.append(ptsUS: 20_000, frames: 480)
        let evidence = ledger.evidence(activeDurationUS: 30_000)
        XCTAssertEqual(evidence.continuityGaps, 1)
        XCTAssertEqual(evidence.failureCodes, [.audioContinuityFailed])
    }

    func testEncoderAndCadenceEvidenceSerializeWithV4FieldNames() throws {
        let envelope = RecordingV4EncoderEnvelope(
            source: "built_in_profile",
            encoderID: "videotoolbox-h264",
            minimumBitrateBPS: 10_000_000,
            targetBitrateBPS: 20_000_000,
            maximumBitrateBPS: 30_000_000,
            safetyHeadroomRatio: 0.25
        )
        let evidence = try RecordingV4EncoderEvidence(
            envelope: envelope,
            averageBitrateBPS: 19_000_000,
            peakBitrateBPS: 24_000_000
        )
        XCTAssertTrue(JSONSerialization.isValidJSONObject(evidence.dictionary))
        XCTAssertEqual(evidence.dictionary["hardware_accelerated"] as? Bool, true)
        XCTAssertEqual(evidence.dictionary["requested_bitrate_bps"] as? Int, 20_000_000)
    }

    func testV4WriterFinalizesHardwareH264WithCadenceEvidence() async throws {
        guard NativeMasterWriter.hardwareEncoderAvailable() else {
            throw XCTSkip("VideoToolbox hardware H.264 is unavailable")
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("storycapture-v4-writer-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let envelope = RecordingV4EncoderEnvelope(
            source: "built_in_profile",
            encoderID: "videotoolbox-h264",
            minimumBitrateBPS: 8_000_000,
            targetBitrateBPS: 16_000_000,
            maximumBitrateBPS: 32_000_000,
            safetyHeadroomRatio: 0.25
        )
        let writer = try NativeMasterWriter(
            artifactPath: directory.appendingPathComponent("video.mp4").path,
            width: 1_920,
            height: 1_080,
            v4Envelope: envelope,
            requestedAudioRoles: [.microphone]
        )
        let pixelBuffer = try makePixelBuffer(width: 1_920, height: 1_080)
        try writer.append(pixelBuffer, sourceSequence: 1, sourceTimestampUS: 1)
        let format = try XCTUnwrap(
            AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: 48_000,
                channels: 2,
                interleaved: false
            )
        )
        let audio = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 960))
        audio.frameLength = 960
        try writer.appendMicrophone(audio)
        try await Task.sleep(nanoseconds: 35_000_000)
        let result = try await writer.finish()
        XCTAssertEqual(result.outputFrames, result.decodedFrames)
        XCTAssertEqual(result.cadence?.ledger.count, Int(result.outputFrames))
        XCTAssertNotNil(result.encoderEvidence)
        XCTAssertEqual(result.audioEvidence.first?.role, .microphone)
        XCTAssertEqual(result.audioEvidence.first?.codec, "aac")
        let asset = AVURLAsset(url: directory.appendingPathComponent("video.mp4"))
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        XCTAssertEqual(audioTracks.count, 1)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(result.dictionary))
    }

    func testV4WriterRejectsNon1080SurfaceBeforeCapture() throws {
        let envelope = RecordingV4EncoderEnvelope(
            source: "built_in_profile",
            encoderID: "videotoolbox-h264",
            minimumBitrateBPS: 8_000_000,
            targetBitrateBPS: 16_000_000,
            maximumBitrateBPS: 32_000_000,
            safetyHeadroomRatio: 0.25
        )
        XCTAssertThrowsError(
            try NativeMasterWriter(
                artifactPath: "/tmp/should-not-exist.mp4",
                width: 1_280,
                height: 720,
                v4Envelope: envelope
            )
        ) { XCTAssertEqual($0 as? HelperFailureCode, .surfaceNot1080p) }
    }

    private func makePixelBuffer(width: Int, height: Int) throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary,
            &buffer
        )
        guard status == kCVReturnSuccess, let buffer else { throw HelperFailureCode.backendUnavailable }
        return buffer
    }
}
