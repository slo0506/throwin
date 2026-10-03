import SwiftUI

#if DEBUG && targetEnvironment(simulator)
/// Simulator-only test input. Reads photos and videos from `~/Claude/throwin-debug-media/<set>/`
/// on the Mac running the Simulator and feeds them through the same path as the camera and
/// photo picker (downsizing, video frame sampling, blur filter). Compiled out of device and
/// release builds, and the media never lives in the repo.
struct DebugMediaButton: View {
    var capture: CaptureModel

    @State private var sets: [URL] = []

    private static var root: URL? {
        ProcessInfo.processInfo.environment["SIMULATOR_HOST_HOME"]
            .map { URL(filePath: $0).appending(path: "Claude/throwin-debug-media") }
    }

    private static let imageTypes: Set<String> = ["jpg", "jpeg", "png", "heic"]
    private static let videoTypes: Set<String> = ["mp4", "mov", "m4v"]

    var body: some View {
        Group {
            if !sets.isEmpty {
                Menu {
                    ForEach(sets, id: \.self) { set in
                        Button(set.lastPathComponent) {
                            Task { await load(set) }
                        }
                    }
                } label: {
                    Label("Test media", systemImage: "hammer")
                        .font(Typo.footnote)
                        .foregroundStyle(Palette.inkTertiary)
                }
            }
        }
        .task { sets = Self.findSets() }
    }

    private static func findSets() -> [URL] {
        guard let root else { return [] }
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: root, includingPropertiesForKeys: [.isDirectoryKey]
        )) ?? []
        return entries
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    private func load(_ set: URL) async {
        let files = ((try? FileManager.default.contentsOfDirectory(at: set, includingPropertiesForKeys: nil)) ?? [])
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        for file in files {
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
