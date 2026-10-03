import ImageIO
import Observation
import PhotosUI
import SwiftUI
import UIKit

/// Live guidance on the camera, in priority order.
enum ShootCue: Equatable {
    case starting, tooDark, moveCloser, holdStill, good

    var text: String {
        switch self {
        case .starting: "Getting the camera ready"
        case .tooDark: "Too dark. Find more light."
        case .moveCloser: "Move closer to fill the frame"
        case .holdStill: "Hold still"
        case .good: "Looks good. Hold it there."
        }
    }

    var symbol: String {
        switch self {
        case .starting: "camera"
        case .tooDark: "lightbulb.max"
        case .moveCloser: "arrow.up.left.and.arrow.down.right"
        case .holdStill: "hand.raised"
        case .good: "checkmark.circle.fill"
        }
    }
}

/// 1 Showcase shoot: walks the angles, takes a photo for each (auto or manual), shows a
/// Studio preview of the best 1, then uploads them and follows the GM's look.
@Observable
final class ShowcaseShootModel {
    enum Phase: Equatable {
        case shooting
        case preparing
        case preview
        case sending
        case following
        case finished
    }

    let itemID: String
    let angles: [String]
    /// nil in the Simulator, without a camera, or when access was denied: the photo picker
    /// stands in, with the same angles.
    private(set) var camera: ShootCamera?
    private(set) var phase: Phase = .shooting
    private(set) var index = 0
    private(set) var cue: ShootCue = .starting
    /// 0 to 1 while the frame stays good, filling the shutter ring until it auto-captures.
    private(set) var holdProgress: Double = 0
    private(set) var isCapturing = false
    private(set) var shots = 0
    private(set) var frames: [Int: PreparedFrame] = [:]
    private(set) var thumbnails: [Int: UIImage] = [:]
    private(set) var bestImage: UIImage?
    private(set) var studioImage: UIImage?
    private(set) var cameraDenied = false

    private var goodSince: Date?
    private var lastShot = Date.distantPast

    /// How long the frame must stay sharp and steady before it shoots itself.
    static let holdDuration = 0.6
    static let darkThreshold = 0.16
    static let smallSubject = 0.1

    init(itemID: String, angles: [String]) {
        self.itemID = itemID
        let cleaned = angles.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        self.angles = Array((cleaned.isEmpty ? ["Front", "Back"] : cleaned).prefix(AppModel.maxItemPhotos))
    }

    var angle: String { angles[min(index, angles.count - 1)] }
    var usesCamera: Bool { camera != nil }

    // MARK: Camera

    /// Opens the camera if there is 1 and the user allows it. Then reads cues until the
    /// shoot ends.
    func run() async {
        guard ShootCamera.isAvailable else { return }
        guard await ShootCamera.requestAccess() else {
            cameraDenied = true
            return
        }
        let camera = ShootCamera()
        self.camera = camera
        camera.start()
        for await cues in camera.cues {
            apply(cues)
        }
    }

    func stop() {
        camera?.stop()
    }

    private func apply(_ cues: FrameCues) {
        guard phase == .shooting, !isCapturing else { return }
        let next: ShootCue
        if cues.brightness < Self.darkThreshold {
            next = .tooDark
        } else if let coverage = cues.coverage, coverage < Self.smallSubject {
            next = .moveCloser
        } else if !cues.isSharp || !cues.isSteady {
            next = .holdStill
        } else {
            next = .good
        }
        if next != cue {
            withAnimation(Motion.snappy) { cue = next }
        }

        guard next == .good else {
            goodSince = nil
            withAnimation(Motion.snappy) { holdProgress = 0 }
            return
        }
        let start = goodSince ?? .now
        goodSince = start
        let held = Date.now.timeIntervalSince(start)
        withAnimation(.linear(duration: 0.15)) { holdProgress = min(1, held / Self.holdDuration) }
        if held >= Self.holdDuration, Date.now.timeIntervalSince(lastShot) > 1.2 {
            Task { await shoot() }
        }
    }

    /// The shutter, pressed or automatic.
    func shoot() async {
        guard let camera, phase == .shooting, !isCapturing else { return }
        isCapturing = true
        goodSince = nil
        holdProgress = 0
        let data = await camera.capturePhoto()
        lastShot = .now
        isCapturing = false
        guard let data else { return }
        await accept(data)
    }

    // MARK: Shots

    /// Keeps a photo (from the camera or the picker) for the current angle and moves on.
    func accept(_ data: Data) async {
        guard phase == .shooting, let frame = await FrameTools.prepare(imageData: data) else { return }
        let slot = index
        frames[slot] = frame
        thumbnails[slot] = UIImage(data: frame.thumbnail)
        shots += 1
        if let next = angles.indices.first(where: { frames[$0] == nil }) {
            withAnimation(Motion.bouncy) {
                index = next
                cue = usesCamera ? .holdStill : .starting
            }
        } else {
            await prepareStudio()
        }
    }

    /// Lets the user redo 1 angle.
    func retake(_ slot: Int) {
        guard angles.indices.contains(slot) else { return }
        withAnimation(Motion.bouncy) {
            frames[slot] = nil
            thumbnails[slot] = nil
            index = slot
            phase = .shooting
            studioImage = nil
            bestImage = nil
        }
        camera?.start()
    }

    /// Picks the sharpest shot and lifts it into Studio. The original shows if Vision can't.
    private func prepareStudio() async {
        withAnimation(Motion.soft) { phase = .preparing }
        camera?.stop()
        let best = frames.values.max { $0.sharpness < $1.sharpness }
        bestImage = best.flatMap { UIImage(data: $0.jpeg) }
        if let best, let source = CGImageSourceCreateWithData(best.jpeg as CFData, nil),
           let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil),
           let made = await StudioRenderer.render(SendableCGImage(image: cgImage), orientation: .up) {
            studioImage = UIImage(cgImage: made.image)
        }
        withAnimation(Motion.soft) { phase = .preview }
    }

    // MARK: Sending

    /// Uploads every angle, then follows the GM's look. Back to the preview if it fails.
    func send(using app: AppModel) async {
        let ordered = angles.indices.compactMap { frames[$0] }
        guard !ordered.isEmpty else { return }
        withAnimation(Motion.soft) { phase = .sending }
        guard await app.sendShowcase(ordered, to: itemID) else {
            withAnimation(Motion.soft) { phase = .preview }
            return
        }
        withAnimation(Motion.soft) { phase = .following }
        // Follows the look here, unless another screen already is (then this returns at once
        // and the wait below watches the Shelf that screen keeps updated).
        await app.followAppraisal(itemID)
        let deadline = Date.now.addingTimeInterval(180)
        while app.shelf.first(where: { $0.id == itemID })?.isAppraising == true, Date.now < deadline {
            do {
                try await Task.sleep(for: .milliseconds(400))
            } catch {
                return
            }
        }
        withAnimation(Motion.bouncy) { phase = .finished }
    }
}

// MARK: - View

/// The guided camera for 1 Item, full screen.
struct ShowcaseShootView: View {
    var itemID: String
    var angles: [String]
    /// True when the photos were sent.
    var onFinish: (Bool) -> Void = { _ in }

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var shoot: ShowcaseShootModel?
    @State private var pick: PhotosPickerItem?
    @State private var isPickerPresented = false
    @State private var showsOriginal = false
    @State private var flash = false
    @State private var burst = 0
    @State private var sent = false

    private var item: ShelfItem? { app.shelf.first { $0.id == itemID } }

    var body: some View {
        ZStack {
            if let shoot {
                content(shoot)
            } else {
                Color.black.ignoresSafeArea()
            }
        }
        .quietBanner()
        .statusBarHidden(shoot?.usesCamera == true && shoot?.phase == .shooting)
        .onAppear {
            if shoot == nil {
                shoot = ShowcaseShootModel(itemID: itemID, angles: angles)
            }
        }
        .task(id: shoot == nil) {
            await shoot?.run()
        }
        .onDisappear {
            shoot?.stop()
            onFinish(sent)
        }
        .photosPicker(isPresented: $isPickerPresented, selection: $pick, matching: .images, preferredItemEncoding: .compatible)
        .onChange(of: pick) { _, picked in
            guard let picked else { return }
            pick = nil
            Task {
                if let data = try? await picked.loadTransferable(type: Data.self) {
                    await shoot?.accept(data)
                }
            }
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: shoot?.shots ?? 0)
        .sensoryFeedback(.success, trigger: burst)
    }

    @ViewBuilder
    private func content(_ shoot: ShowcaseShootModel) -> some View {
        switch shoot.phase {
        case .shooting:
            if shoot.usesCamera, let camera = shoot.camera {
                cameraScreen(shoot, camera: camera)
                    .transition(.opacity)
            } else {
                pickerScreen(shoot)
                    .transition(.opacity)
            }
        case .preparing, .preview, .sending, .following, .finished:
            reviewScreen(shoot)
                .transition(.blurReplace)
        }
    }

    // MARK: Camera

    private func cameraScreen(_ shoot: ShowcaseShootModel, camera: ShootCamera) -> some View {
        ZStack {
            Color.black.ignoresSafeArea()
            CameraPreview(camera: camera)
                .ignoresSafeArea()
            GhostOutline(angle: shoot.angle, color: .white)
                .padding(.horizontal, Space.huge)
                .padding(.vertical, 150)
                .id(shoot.index)
                .transition(.scale(scale: 1.08).combined(with: .opacity))
            Color.white
                .ignoresSafeArea()
                .opacity(flash ? 0.7 : 0)
                .allowsHitTesting(false)

            VStack(spacing: Space.md) {
                shootTopBar(shoot)
                cueCapsule(shoot.cue)
                Spacer()
                shotStrip(shoot)
                shutter(shoot)
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.lg)
        }
        .environment(\.colorScheme, .dark)
        .onChange(of: shoot.shots) { _, _ in
            flash = true
            withAnimation(.easeOut(duration: 0.35)) { flash = false }
        }
    }

    private func shootTopBar(_ shoot: ShowcaseShootModel) -> some View {
        HStack {
            closeButton
            Spacer()
            VStack(spacing: 0) {
                Text(shoot.angle)
                    .font(Typo.headline)
                    .contentTransition(.opacity)
                Text("\(min(shoot.index + 1, shoot.angles.count)) of \(shoot.angles.count)")
                    .font(Typo.footnote.monospacedDigit())
                    .foregroundStyle(Palette.inkSecondary)
                    .contentTransition(.numericText())
            }
            .padding(.horizontal, Space.md)
            .padding(.vertical, 6)
            .glassEffect(.regular, in: .capsule)
            .animation(Motion.snappy, value: shoot.index)
            Spacer()
            Color.clear.frame(width: 44, height: 44)
        }
        .padding(.top, Space.xs)
    }

    private func cueCapsule(_ cue: ShootCue) -> some View {
        Label(cue.text, systemImage: cue.symbol)
            .font(.system(size: 15, weight: .semibold, design: .rounded))
            .foregroundStyle(cue == .good ? Palette.mint : Palette.ink)
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.xs)
            .glassEffect(.regular, in: .capsule)
            .id(cue)
            .transition(.blurReplace)
            .animation(Motion.snappy, value: cue)
            .accessibilityAddTraits(.updatesFrequently)
    }

    private func shutter(_ shoot: ShowcaseShootModel) -> some View {
        Button {
            Task { await shoot.shoot() }
        } label: {
            ZStack {
                Circle()
                    .strokeBorder(.white.opacity(0.35), lineWidth: 4)
                Circle()
                    .trim(from: 0, to: shoot.holdProgress)
                    .stroke(Palette.mint, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .padding(2)
                Circle()
                    .fill(.white)
                    .padding(9)
                    .scaleEffect(shoot.isCapturing ? 0.86 : 1)
                    .animation(Motion.snappy, value: shoot.isCapturing)
            }
            .frame(width: 78, height: 78)
        }
        .buttonStyle(.pressable)
        .disabled(shoot.isCapturing)
        .accessibilityLabel("Take photo of \(shoot.angle)")
    }

    // MARK: Picker fallback

    private func pickerScreen(_ shoot: ShowcaseShootModel) -> some View {
        ZStack {
            Palette.canvas.ignoresSafeArea()
            VStack(spacing: Space.lg) {
                HStack {
                    closeButton
                    Spacer()
                }
                .padding(.top, Space.xs)

                VStack(spacing: Space.xs) {
                    Text(shoot.angle)
                        .font(Typo.title)
                        .tracking(-0.4)
                        .contentTransition(.opacity)
                    Text("\(min(shoot.index + 1, shoot.angles.count)) of \(shoot.angles.count). "
                         + (shoot.cameraDenied
                            ? "Camera access is off, so pick a photo instead."
                            : "No camera here, so pick a photo instead."))
                        .font(Typo.callout)
                        .foregroundStyle(Palette.inkSecondary)
                        .multilineTextAlignment(.center)
                }
                .animation(Motion.snappy, value: shoot.index)

                GhostOutline(angle: shoot.angle, color: Palette.ink)
                    .padding(.horizontal, Space.xxl)
                    .frame(maxHeight: 360)
                    .id(shoot.index)
                    .transition(.scale(scale: 1.08).combined(with: .opacity))

                Spacer(minLength: 0)
                shotStrip(shoot)
                Button {
                    isPickerPresented = true
                } label: {
                    PrimaryLabel("Choose a photo", symbol: "photo.on.rectangle")
                        .frame(height: 48)
                }
                .buttonStyle(.glassProminent)
                .tint(Palette.ink)
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.lg)
        }
    }

    // MARK: Review

    private func reviewScreen(_ shoot: ShowcaseShootModel) -> some View {
        ZStack {
            Palette.canvas.ignoresSafeArea()
            VStack(spacing: Space.lg) {
                HStack {
                    if shoot.phase == .preview || shoot.phase == .preparing {
                        closeButton
                    }
                    Spacer()
                }
                .frame(height: 44)
                .padding(.top, Space.xs)

                Text(reviewTitle(shoot))
                    .font(Typo.title2)
                    .multilineTextAlignment(.center)
                    .contentTransition(.opacity)

                previewImage(shoot)

                if shoot.phase == .preview {
                    if shoot.studioImage == nil {
                        Text("Studio couldn't lift this photo cleanly, so your original goes up as is.")
                            .font(Typo.footnote)
                            .foregroundStyle(Palette.inkSecondary)
                            .multilineTextAlignment(.center)
                    }
                    shotStrip(shoot, canRetake: true)
                }

                Spacer(minLength: 0)
                reviewActions(shoot)
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.lg)
            .animation(Motion.soft, value: shoot.phase)
            CelebrationBurst(trigger: burst, origin: UnitPoint(x: 0.5, y: 0.35))
                .ignoresSafeArea()
                .allowsHitTesting(false)
        }
        .onChange(of: shoot.phase) { _, phase in
            if phase == .following { sent = true }
            if phase == .finished, item?.readiness == .showcase { burst += 1 }
        }
    }

    private func reviewTitle(_ shoot: ShowcaseShootModel) -> String {
        switch shoot.phase {
        case .preparing: "Lifting it into Studio"
        case .sending: "Sending \(shoot.frames.count) \(shoot.frames.count == 1 ? "photo" : "photos")"
        case .following: "Your GM is taking a look"
        case .finished: item?.readiness == .showcase ? "Ready to show" : "Thanks, that helps"
        default: "Studio preview"
        }
    }

    @ViewBuilder
    private func previewImage(_ shoot: ShowcaseShootModel) -> some View {
        let studio = showsOriginal ? nil : shoot.studioImage
        ZStack {
            if let studio {
                StudioImageView(image: studio)
                    .transition(.opacity)
            } else if let original = shoot.bestImage {
                Image(uiImage: original)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            } else {
                Palette.surface
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .appraiseScan(trigger: shoot.phase == .following ? 1 : 0, duration: 1.8)
        .shadow(color: .black.opacity(0.1), radius: 24, y: 12)
        .overlay(alignment: .bottomTrailing) {
            if shoot.studioImage != nil, shoot.phase == .preview {
                StudioToggle(showsOriginal: $showsOriginal)
                    .padding(Space.sm)
            }
        }
        .overlay {
            if shoot.phase == .preparing || shoot.phase == .sending || shoot.phase == .following {
                LoopIndicator(people: 3, size: 40)
                    .padding(Space.lg)
                    .glassEffect(.regular, in: .circle)
                    .transition(.scale.combined(with: .opacity))
            }
        }
        .animation(Motion.soft, value: showsOriginal)
    }

    @ViewBuilder
    private func reviewActions(_ shoot: ShowcaseShootModel) -> some View {
        switch shoot.phase {
        case .preview:
            Button {
                Task { await shoot.send(using: app) }
            } label: {
                PrimaryLabel("Send to your GM", symbol: "paperplane.fill")
                    .frame(height: 48)
            }
            .buttonStyle(.glassProminent)
            .tint(Palette.ink)
        case .finished:
            VStack(spacing: Space.sm) {
                if let item {
                    ReadinessMeter(readiness: item.readiness)
                        .padding(.horizontal, Space.xs)
                        .padding(.bottom, Space.sm)
                }
                Button {
                    dismiss()
                } label: {
                    PrimaryLabel("Done")
                        .frame(height: 48)
                }
                .buttonStyle(.glassProminent)
                .tint(Palette.ink)
            }
        case .following:
            Text("You can close this. It updates on your Shelf either way.")
                .font(Typo.footnote)
                .foregroundStyle(Palette.inkTertiary)
            Button("Close") {
                dismiss()
            }
            .font(Typo.callout)
            .foregroundStyle(Palette.inkSecondary)
        default:
            EmptyView()
        }
    }

    // MARK: Shared parts

    private var closeButton: some View {
        Button {
            dismiss()
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(Palette.ink)
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel("Close")
    }

    /// 1 slot per angle: the shot once taken, else its label. In review, a tap retakes it.
    private func shotStrip(_ shoot: ShowcaseShootModel, canRetake: Bool = false) -> some View {
        HStack(spacing: Space.xs) {
            ForEach(Array(shoot.angles.enumerated()), id: \.offset) { slot, angle in
                Button {
                    shoot.retake(slot)
                } label: {
                    ZStack {
                        if let thumb = shoot.thumbnails[slot] {
                            Image(uiImage: thumb)
                                .resizable()
                                .scaledToFill()
                                .transition(.scale(scale: 0.6).combined(with: .opacity))
                        } else {
                            Text(angle)
                                .font(.system(size: 10, weight: .semibold, design: .rounded))
                                .foregroundStyle(Palette.inkSecondary)
                                .multilineTextAlignment(.center)
                                .lineLimit(2)
                                .minimumScaleFactor(0.8)
                                .padding(4)
                        }
                    }
                    .frame(width: 52, height: 52)
                    .background(Palette.surface.opacity(0.6))
                    .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
                            .strokeBorder(slot == shoot.index && shoot.phase == .shooting ? Palette.mint : Palette.hairline, lineWidth: 2)
                    }
                }
                .buttonStyle(.pressable)
                .disabled(!canRetake || shoot.thumbnails[slot] == nil)
                .accessibilityLabel(canRetake ? "Retake \(angle)" : angle)
            }
        }
        .animation(Motion.bouncy, value: shoot.shots)
    }
}

// MARK: - Ghost outline

/// A soft dashed frame with a hint of what this angle should show.
private struct GhostOutline: View {
    var angle: String
    var color: Color

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(color.opacity(0.55), style: StrokeStyle(lineWidth: 2, dash: [10, 8]))
            VStack(spacing: Space.sm) {
                Image(systemName: Self.symbol(for: angle))
                    .font(.system(size: 64, weight: .light))
                    .foregroundStyle(color.opacity(0.35))
                Text(angle)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(color.opacity(0.6))
            }
        }
        .aspectRatio(0.8, contentMode: .fit)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    static func symbol(for angle: String) -> String {
        let label = angle.lowercased()
        if label.contains("sole") { return "shoeprints.fill" }
        if label.contains("tag") || label.contains("label") { return "tag" }
        if label.contains("side") || label.contains("profile") { return "shoe" }
        if label.contains("port") { return "cable.connector" }
        if label.contains("spine") || label.contains("cover") || label.contains("page") { return "book.closed" }
        if label.contains("corner") { return "square.dashed" }
        if label.contains("key") || label.contains("close") { return "plus.magnifyingglass" }
        if label.contains("box") || label.contains("contents") { return "shippingbox" }
        if label.contains("back") { return "arrow.uturn.backward.square" }
        return "viewfinder"
    }
}
