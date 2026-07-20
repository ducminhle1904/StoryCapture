import AppKit
import Foundation
import ScreenCaptureCore

@main
struct StoryCaptureScreenCaptureHelper {
    static func main() async {
        let control = ControlChannel()
        let controller = ScreenCaptureHelperController(
            control: control,
            packets: BinaryPacketChannel()
        )
        let decoder = JSONDecoder()
        installSleepObserver(control: control)

        while let line = readLine(strippingNewline: true) {
            guard let data = line.data(using: .utf8),
                  let command = try? decoder.decode(HelperCommand.self, from: data) else {
                control.fail(nil, code: .contractMismatch, message: "invalid helper command")
                continue
            }
            let keepRunning = await controller.handle(command)
            if !keepRunning { break }
        }
    }

    private static func installSleepObserver(control: ControlChannel) {
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.screensDidSleepNotification,
            object: nil,
            queue: nil
        ) { _ in
            control.fail(nil, code: .targetLost, message: "display entered sleep during capture")
        }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: nil
        ) { _ in
            control.send([
                "version": helperProtocolVersion,
                "event": "wake",
                "ok": true,
            ])
        }
    }
}
