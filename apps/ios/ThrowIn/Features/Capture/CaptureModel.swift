import Observation
import SwiftUI

/// 1 trip to the camera: collect photos or a video, upload them, and follow the Appraiser
/// until the Items are ready.
@Observable
final class CaptureModel {
    enum Phase: Equatable {
        case collecting
        case uploading(done: Int, total: Int)
        case working(String)
        case finished(items: [ShelfItem], summary: String)
        case failed(String)

        var isBusy: Bool {
            switch self {
            case .uploading, .working: true
            default: false
            }
        }
    }

    private(set) var frames: [PreparedFrame] = []
    private(set) var phase: Phase = .collecting
    private(set) var isPreparing = false
    /// Photos picked or shot but still loading. Shown as placeholder tiles, so a pick answers
    /// at once instead of after the first photo decodes.
    private(set) var pending = 0
    /// Decoded tray thumbnails, keyed by frame.
    private(set) var thumbnails: [UUID: UIImage] = [:]
    /// Items the Appraiser has found so far, shown while it keeps working.
    private(set) var arrivedItems: [ShelfItem] = []

    var isFull: Bool { frames.count + pending >= FrameTools.maxFrames }
    var canSubmit: Bool { !frames.isEmpty && !isPreparing && pending == 0 && phase == .collecting }

    /// Call the moment the user picks, before any loading starts.
    func expect(_ count: Int) {
        withAnimation(Motion.bouncy) { pending += count }
    }

    /// 1 expected photo or video finished loading, whether or not it worked.
    func settle() {
        withAnimation(Motion.bouncy) { pending = max(0, pending - 1) }
    }

    // MARK: Collecting

    func add(imageData: [Data]) async {
        isPreparing = true
        defer { isPreparing = false }
        for data in imageData where !isFull {
            if let frame = await FrameTools.prepare(imageData: data) {
                append(frame)
            }
        }
    }

    func add(videoAt url: URL) async {
        isPreparing = true
        defer {
            isPreparing = false
            try? FileManager.default.removeItem(at: url)
        }
        guard let sampled = try? await FrameTools.frames(fromVideo: url) else { return }
        for frame in sampled where !isFull {
            append(frame)
        }
    }

    func remove(_ id: UUID) {
        withAnimation(Motion.snappy) {
            frames.removeAll { $0.id == id }
        }
        thumbnails[id] = nil
    }

    private func append(_ frame: PreparedFrame) {
        thumbnails[frame.id] = UIImage(data: frame.thumbnail)
        withAnimation(Motion.bouncy) {
            frames.append(frame)
        }
    }

    /// Back to the tray after a failure. The photos stay; a new capture is made on submit.
    func retry() {
        withAnimation(Motion.soft) { phase = .collecting }
    }

    // MARK: Submitting

    func submit(using api: APIClient) async {
        let frames = Array(frames.prefix(FrameTools.maxFrames))
        guard !frames.isEmpty, phase == .collecting else { return }
        arrivedItems = []
        setPhase(.uploading(done: 0, total: frames.count))
        do {
            let slots = try await api.requestUploads(count: frames.count)
            guard slots.uploads.count == frames.count else { throw Self.genericError }

            // Retries and the 4-at-a-time cap live in the client. If a photo still fails, the
            // frames stay in the tray so Try again sends them all on a fresh capture.
            let jobs = zip(frames, slots.uploads).map { (jpeg: $0.jpeg, url: $1.uploadUrl) }
            try await api.uploadAll(jobs) { done in
                setPhase(.uploading(done: done, total: frames.count))
            }

            let media = zip(frames, slots.uploads).map { frame, slot in
                CaptureMediaInput(path: slot.path, width: frame.width, height: frame.height, sharpness: frame.sharpness)
            }
            var capture = try await api.submitCapture(CaptureRequest(captureId: slots.captureId, media: media))
            setPhase(.working(capture.progress.detail ?? "Looking at your photos"))
            receive(capture.items)
            capture = try await follow(capture, using: api)

            if capture.status == .failed {
                setPhase(.failed(capture.error ?? "Something went wrong reading these photos. Try again."))
            } else {
                let summary = capture.progress.detail ?? "Added \(capture.items.count) items to your Shelf"
                setPhase(.finished(items: capture.items, summary: summary))
            }
        } catch is CancellationError {
            return
        } catch {
            setPhase(.failed((error as? LocalizedError)?.errorDescription ?? "Something went wrong. Try again."))
        }
    }

    /// Polls until the Appraiser is done. Rides out a few dropped requests on bad networks.
    private func follow(_ start: Capture, using api: APIClient) async throws -> Capture {
        var capture = start
        var misses = 0
        let deadline = Date.now.addingTimeInterval(300)
        while capture.status == .processing || capture.status == .uploading {
            try await Task.sleep(for: .seconds(2))
            guard Date.now < deadline else {
                throw APIError(status: 0, code: "timeout", message: "This is taking longer than usual. Your items will show up on your Shelf when they're ready.")
            }
            do {
                capture = try await api.capture(capture.id)
                misses = 0
                if capture.status == .processing {
                    if let detail = capture.progress.detail {
                        setPhase(.working(detail))
                    }
                    receive(capture.items)
                }
            } catch let error as APIError where error.status >= 400 && error.status < 500 {
                throw error
            } catch {
                misses += 1
                if misses >= 4 { throw error }
            }
        }
        return capture
    }

    /// Items arrive named before they're priced. Keeps the first-seen order so cards already
    /// dealt in don't shuffle, and refreshes each 1 in place as its price lands.
    private func receive(_ items: [ShelfItem]) {
        guard !items.isEmpty, items != arrivedItems else { return }
        var merged = arrivedItems.map { old in items.first { $0.id == old.id } ?? old }
        merged += items.filter { item in !arrivedItems.contains { $0.id == item.id } }
        withAnimation(Motion.bouncy) { arrivedItems = merged }
    }

    private func setPhase(_ next: Phase) {
        guard next != phase else { return }
        withAnimation(Motion.soft) { phase = next }
    }

    private static let genericError = APIError(status: 0, code: "upload_mismatch", message: "Something went wrong. Try again.")
}
