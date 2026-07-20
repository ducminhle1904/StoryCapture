import CoreMedia
import XCTest
@testable import ScreenCaptureCore

final class ProtocolAndIdentityTests: XCTestCase {
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
}
