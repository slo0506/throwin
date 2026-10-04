import SwiftUI

#if DEBUG && targetEnvironment(simulator)
/// Simulator-only test input. Reads photos and videos from `~/Claude/throwin-debug-media/<set>/`
/// on the Mac running the Simulator and feeds them through the same path as the camera and
/// photo picker (downsizing, video frame sampling, blur filter). Compiled out of device and
/// release builds, and the media never lives in the repo.
struct DebugMediaButton: View {
    var capture: CaptureModel

    @State private var sets: [URL] = []

    /// The Mac's home folder. Simulator apps live under ~/Library/Developer/CoreSimulator on the
    /// host, so the prefix of the app's own home is the Mac's home when the variable is unset.
    private static var hostHome: String? {
        if let home = ProcessInfo.processInfo.environment["SIMULATOR_HOST_HOME"] { return home }
        let appHome = NSHomeDirectory()
        guard let range = appHome.range(of: "/Library/Developer/CoreSimulator") else { return nil }
        return String(appHome[..<range.lowerBound])
    }

    private static var root: URL? {
        hostHome.map { URL(filePath: $0).appending(path: "Claude/throwin-debug-media") }
    }

    private static let imageTypes: Set<String> = ["jpg", "jpeg", "png", "heic"]
    private static let videoTypes: Set<String> = ["mp4", "mov", "m4v"]

    var body: some View {
        // Always render something: SwiftUI never runs .task on a view with no content.
        Menu {
            ForEach(sets, id: \.self) { set in
                Button(set.lastPathComponent) {
                    Task { await load(set) }
                }
            }
        } label: {
            Label(sets.isEmpty ? "No test media" : "Test media", systemImage: "hammer")
                .font(Typo.footnote)
                .foregroundStyle(Palette.inkTertiary)
        }
        .disabled(sets.isEmpty)
        .task { sets = Self.findSets() }
    }

    private static func findSets() -> [URL] {
        guard let root else {
            print("[DebugMedia] no host home found")
            return []
        }
        let entries: [URL]
        do {
            entries = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey])
        } catch {
            print("[DebugMedia] can't read \(root.path()): \(error)")
            return []
        }
        return entries
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    private func load(_ set: URL) async {
        let files = ((try? FileManager.default.contentsOfDirectory(at: set, includingPropertiesForKeys: nil)) ?? [])
            .filter { Self.imageTypes.contains($0.pathExtension.lowercased()) || Self.videoTypes.contains($0.pathExtension.lowercased()) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        // The same placeholder path as the photo picker, so it's testable here.
        capture.expect(files.count)
        for file in files {
            defer { capture.settle() }
            let ext = file.pathExtension.lowercased()
            if Self.imageTypes.contains(ext), let data = try? Data(contentsOf: file) {
                await capture.add(imageData: [data])
            } else if Self.videoTypes.contains(ext) {
                // add(videoAt:) deletes its input when done, so hand it a copy.
                let copy = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).\(ext)")
                if (try? FileManager.default.copyItem(at: file, to: copy)) != nil {
                    await capture.add(videoAt: copy)
                }
            }
        }
    }
}
#endif
