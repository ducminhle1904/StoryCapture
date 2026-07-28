import AVFoundation
import CoreMedia
import CoreVideo
import XCTest
@testable import ScreenCaptureCore

final class ProtocolAndIdentityTests: XCTestCase {
    func testNativeMasterV3CommandDecodesWithoutChangingV2Default() throws {
        let json = #"{"version":3,"request_id":"r1","command":"start","session_id":"take","payload":{"target":{"kind":"window","windowID":42,"mediaSourceID":"window:42:0"},"outputWidth":1920,"outputHeight":1080,"expectedLogicalWidth":960,"expectedLogicalHeight":540,"artifactPath":"/tmp/video.mp4","fpsNumerator":60,"fpsDenominator":1}}"#
        let command = try JSONDecoder().decode(HelperCommand.self, from: Data(json.utf8))
        XCTAssertEqual(command.version, nativeMasterProtocolVersion)
        XCTAssertEqual(command.payload?.target?.mediaSourceID, "window:42:0")
        XCTAssertEqual(command.payload?.artifactPath, "/tmp/video.mp4")
        XCTAssertEqual(
            HelperCommand(requestID: "v2", command: .hello).version,
            helperProtocolVersion
        )
    }

    func testPacketHeaderIsStableLittleEndianV2() {
        let header = NativePacketHeader(
            kind: .videoBGRA,
            sequence: 12,
            nativePTSUS: 34_000,
            width: 1_920,
            height: 1_080,
            stride: 7_680,
            format: 1,
            payloadBytes: 8_294_400
        ).encode()
        XCTAssertEqual(header.count, 64)
        XCTAssertEqual(Array(header.prefix(8)), NativePacketHeader.magic)
        XCTAssertEqual(header.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 16, as: UInt64.self) }.littleEndian, 12)
        XCTAssertEqual(header.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 24, as: UInt64.self) }.littleEndian, 34_000)
    }

    func testDisplayIdentityRejectsMissingAmbiguousAndChangedTargets() throws {
        let target = HelperTarget(kind: .display, displayID: 7)
        XCTAssertThrowsError(try TargetIdentityResolver.display(target: target, candidates: [])) {
            XCTAssertEqual($0 as? HelperFailureCode, .targetMissing)
        }
        let candidate = DisplayIdentityCandidate(
            displayID: 7,
            logicalWidth: 1_920,
            logicalHeight: 1_080,
            physicalWidth: 3_840,
            physicalHeight: 2_160,
            originX: 0,
            originY: 0
        )
        XCTAssertThrowsError(
            try TargetIdentityResolver.display(target: target, candidates: [candidate, candidate])
        ) {
            XCTAssertEqual($0 as? HelperFailureCode, .targetAmbiguous)
        }
        let first = try TargetIdentityResolver.display(target: target, candidates: [candidate])
        let changed = HelperTarget(kind: .display, displayID: 7, expectedIdentity: first.fingerprint)
        XCTAssertThrowsError(
            try TargetIdentityResolver.display(
                target: changed,
                candidates: [DisplayIdentityCandidate(
                    displayID: 7,
                    logicalWidth: 1_280,
                    logicalHeight: 720,
                    physicalWidth: 2_560,
                    physicalHeight: 1_440,
                    originX: 0,
                    originY: 0
                )]
            )
        ) {
            XCTAssertEqual($0 as? HelperFailureCode, .targetChanged)
        }
    }

    func testWindowIdentityUsesPIDBundleAndRetinaScale() throws {
        let candidate = WindowIdentityCandidate(
            windowID: 42,
            ownerPID: 99,
            ownerBundleID: "com.example.Editor",
            title: "Document",
            width: 960,
            height: 540
        )
        let identity = try TargetIdentityResolver.window(
            target: HelperTarget(
                kind: .window,
                windowID: 42,
                ownerPID: 99,
                ownerBundleID: "com.example.Editor"
            ),
            candidates: [candidate],
            scaleFactor: 2
        )
        XCTAssertEqual(identity.logicalWidth, 960)
        XCTAssertEqual(identity.physicalWidth, 1_920)
        XCTAssertEqual(identity.physicalHeight, 1_080)
    }

    func testLifecycleRejectsInvalidTransitionsAndSupportsPauseResume() throws {
        var lifecycle = CaptureLifecycle()
        try lifecycle.start()
        try lifecycle.pause()
        try lifecycle.resume()
        try lifecycle.stop()
        XCTAssertEqual(lifecycle.state, .stopped)
        XCTAssertThrowsError(try lifecycle.pause())
        lifecycle.fail()
        XCTAssertEqual(lifecycle.state, .failed)
    }

    func testCMTimeConversionPreservesNativeMonotonicMicroseconds() {
        XCTAssertEqual(monotonicMicroseconds(CMTime(value: 1, timescale: 60)), 16_667)
        XCTAssertNil(monotonicMicroseconds(.invalid))
    }

    func testMediaSourceWindowIdentityParsesExactCGWindowID() {
        XCTAssertEqual(windowIDFromMediaSourceID("window:42:0"), 42)
        XCTAssertNil(windowIDFromMediaSourceID("screen:42:0"))
        XCTAssertNil(windowIDFromMediaSourceID("window:not-a-number:0"))
    }

    func testNativeMasterFinalizesAndDecodesShortH264Artifact() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("storycapture-native-master-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let artifact = directory.appendingPathComponent("video.mp4")
        let writer = try NativeMasterWriter(
            artifactPath: artifact.path,
            width: 320,
            height: 180
        )
        let pixelBuffer = try makePixelBuffer(width: 320, height: 180)
        try writer.append(pixelBuffer)
        try writer.pause()
        try await Task.sleep(nanoseconds: 30_000_000)
        try writer.resume()
        try await Task.sleep(nanoseconds: 50_000_000)
        try writer.append(pixelBuffer)
        try await Task.sleep(nanoseconds: 20_000_000)
        let result = try await writer.finish()

        XCTAssertTrue(result.artifactBytes > 0)
        XCTAssertTrue(result.outputFrames >= 2)
        XCTAssertTrue(result.heldFrames > 0)
        XCTAssertEqual(result.encoderDroppedFrames, 0)
        let asset = AVURLAsset(url: artifact)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        XCTAssertEqual(tracks.count, 1)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: tracks[0], outputSettings: nil)
        XCTAssertTrue(reader.canAdd(output))
        reader.add(output)
        XCTAssertTrue(reader.startReading())
        var decodedFrames = 0
        while let buffer = output.copyNextSampleBuffer() {
            decodedFrames += CMSampleBufferGetNumSamples(buffer)
        }
        XCTAssertEqual(reader.status, .completed)
        XCTAssertEqual(decodedFrames, Int(result.outputFrames))
        XCTAssertEqual(result.decodedFrames, result.outputFrames)
    }

    func testNativeMasterEpochBeginsWithFirstSurface() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("storycapture-native-master-epoch-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let artifact = directory.appendingPathComponent("video.mp4")
        let writer = try NativeMasterWriter(artifactPath: artifact.path, width: 320, height: 180)
        let pixelBuffer = try makePixelBuffer(width: 320, height: 180)

        try await Task.sleep(nanoseconds: 50_000_000)
        try writer.append(pixelBuffer)
        try await Task.sleep(nanoseconds: 20_000_000)
        let result = try await writer.finish()

        XCTAssertEqual(result.heldFrames, 1)
        XCTAssertLessThan(result.finalizedDurationUS, 100_000)
    }

    private func makePixelBuffer(width: Int, height: Int) throws -> CVPixelBuffer {
        var pixelBuffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pixelBuffer else {
            throw HelperFailureCode.backendUnavailable
        }
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        if let address = CVPixelBufferGetBaseAddress(pixelBuffer) {
            memset(address, 0x7f, CVPixelBufferGetBytesPerRow(pixelBuffer) * height)
        }
        CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
        return pixelBuffer
    }
}
