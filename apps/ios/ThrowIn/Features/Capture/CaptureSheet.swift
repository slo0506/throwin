import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Add to Shelf: take photos, film a shelf or choose from the library, then watch the Items
/// land on the Shelf.
struct CaptureSheet: View {
    var onFinish: () -> Void
    /// Set by the Shelf: closes this sheet and opens Tune up on the new Items.
    var onTuneUp: (() -> Void)?

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var capture = CaptureModel()
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var isPickerPresented = false
    @State private var isCameraPresented = false
    /// The camera opens for video (Film a shelf) or for stills (Take photos).
    @State private var cameraFilms = true
    @State private var scanTick = 0
    @State private var burst = 0

    private var cameraAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.canvas.ignoresSafeArea()
                content
                    .padding(.horizontal, Space.gutter)
                CelebrationBurst(trigger: burst, origin: UnitPoint(x: 0.5, y: 0.3))
                    .allowsHitTesting(false)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if !capture.phase.isBusy {
                        Button("Close", systemImage: "xmark") { close() }
                    }
                }
            }
        }
        .interactiveDismissDisabled(capture.phase.isBusy)
        .photosPicker(
            isPresented: $isPickerPresented,
            selection: $pickerItems,
            maxSelectionCount: max(1, FrameTools.maxFrames - capture.frames.count),
            matching: .any(of: [.images, .videos]),
            preferredItemEncoding: .compatible
        )
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            pickerItems = []
            // Placeholders first, so the tray answers the pick right away.
            capture.expect(items.count)
            Task { await load(items) }
        }
        .fullScreenCover(isPresented: $isCameraPresented) {
            CameraPicker(allowsVideo: cameraFilms) { result in
                capture.expect(1)
                Task {
                    switch result {
                    case let .photo(data): await capture.add(imageData: [data])
                    case let .video(url): await capture.add(videoAt: url)
                    }
                    capture.settle()
                }
            }
            .ignoresSafeArea()
        }
        .task(id: capture.phase.isBusy) {
            // Keep the scan sweeping while the GM works.
            while capture.phase.isBusy, !Task.isCancelled {
                scanTick += 1
                try? await Task.sleep(for: .seconds(2.1))
            }
        }
        .onChange(of: capture.phase) { _, phase in
            if case let .finished(items, _) = phase, !items.isEmpty { burst += 1 }
        }
        .sensoryFeedback(.success, trigger: burst)
    }

    @ViewBuilder
    private var content: some View {
        switch capture.phase {
        case .collecting:
            collecting
                .transition(.blurReplace)
        case .uploading, .working:
            // 1 branch for both, so the deck stays put and only the caption changes.
            working(detail: workingDetail)
                .transition(.blurReplace)
        case let .finished(items, summary):
            CaptureResults(
                items: items,
                summary: summary,
                onDone: close,
                onAgain: startOver,
                onTuneUp: tuneUpAction
            )
                .transition(.blurReplace)
        case let .failed(message):
            failed(message)
                .transition(.blurReplace)
        }
    }

    // MARK: Collecting

    private var collecting: some View {
        VStack(spacing: Space.xl) {
            VStack(spacing: Space.xs) {
                Text(isEmpty ? "What are you trading?" : photoCount)
                    .font(Typo.title)
                    .tracking(-0.4)
                    .contentTransition(.numericText())
                Text(isEmpty
                     ? "Snap a few things, or film a whole shelf. We'll name and price each one."
                     : capture.pending > 0 ? "Getting your photos ready." : "Add more, or add these to your Shelf.")
                    .font(Typo.callout)
                    .foregroundStyle(Palette.inkSecondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, Space.xl)

            if isEmpty {
                sourceButtons
                Spacer()
            } else {
                tray
                Spacer()
                HStack(spacing: Space.sm) {
                    Menu {
                        if cameraAvailable {
                            Button("Take photos", systemImage: "camera") { openCamera(filming: false) }
                            Button("Film a shelf", systemImage: "video") { openCamera(filming: true) }
                        }
                        Button("Choose from library", systemImage: "photo.on.rectangle") { isPickerPresented = true }
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 19, weight: .bold))
                            .foregroundStyle(Palette.ink)
                            .frame(width: 56, height: 56)
                    }
                    .glassEffect(.regular.interactive(), in: .circle)
                    .disabled(capture.isFull)
                    .accessibilityLabel("Add more")

                    Button {
                        guard let api = app.api else { return }
                        Task { await capture.submit(using: api) }
                    } label: {
                        PrimaryLabel("Add to Shelf", symbol: "plus")
                            .frame(height: 48)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(Palette.ink)
                    .disabled(!capture.canSubmit)
                }
                .padding(.bottom, Space.lg)
            }
        }
    }

    private var isEmpty: Bool { capture.frames.isEmpty && capture.pending == 0 }

    private var photoCount: String {
        let n = capture.frames.count + capture.pending
        return n == 1 ? "1 photo" : "\(n) photos"
    }

    private func openCamera(filming: Bool) {
        cameraFilms = filming
        isCameraPresented = true
    }

    private var sourceButtons: some View {
        VStack(spacing: Space.md) {
            SourceTile(
                title: "Take photos",
                detail: cameraAvailable ? "1 or a few things at a time" : "Needs a camera",
                symbol: "camera.fill",
                tint: Palette.tangerine
            ) { openCamera(filming: false) }
            .disabled(!cameraAvailable)

            SourceTile(
                title: "Film a shelf",
                detail: cameraAvailable ? "Slow pan, 15 to 60 seconds" : "Needs a camera",
                symbol: "video.fill",
                tint: Palette.bubblegum
            ) { openCamera(filming: true) }
            .disabled(!cameraAvailable)

            SourceTile(
                title: "Choose from library",
                detail: "Up to 30 photos, or a video",
                symbol: "photo.stack.fill",
                tint: Palette.iris
            ) { isPickerPresented = true }

            #if DEBUG && targetEnvironment(simulator)
            DebugMediaButton(capture: capture)
            #endif
        }
    }

    private var tray: some View {
        ScrollView(.horizontal) {
            HStack(spacing: Space.sm) {
                ForEach(capture.frames) { frame in
                    ZStack(alignment: .topTrailing) {
                        thumbnail(frame)
                            .frame(width: 112, height: 140)
                            .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                        Button {
                            capture.remove(frame.id)
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(Palette.ink)
                                .frame(width: 26, height: 26)
                        }
                        .glassEffect(.regular.interactive(), in: .circle)
                        .padding(6)
                        .accessibilityLabel("Remove photo")
                    }
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                }
                ForEach(0..<capture.pending, id: \.self) { _ in
                    PendingTile()
                        .frame(width: 112, height: 140)
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                }
            }
            .padding(.vertical, Space.xs)
        }
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
    }

    @ViewBuilder
    private func thumbnail(_ frame: PreparedFrame) -> some View {
        if let image = capture.thumbnails[frame.id] {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else {
            Palette.surface
        }
    }

    // MARK: Working

    private var workingDetail: String {
        switch capture.phase {
        case let .uploading(done, total): "Sending \(done) of \(total) photos"
        case let .working(detail): detail
        default: ""
        }
    }

    private func working(detail: String) -> some View {
        let hasItems = !capture.arrivedItems.isEmpty
        return VStack(spacing: hasItems ? Space.lg : Space.xxl) {
            Spacer()
            FrameDeck(images: capture.frames.prefix(5).compactMap { capture.thumbnails[$0.id] }, scanTick: scanTick)
                .frame(height: hasItems ? 200 : 260)
                .scaleEffect(hasItems ? 0.82 : 1)
            if hasItems {
                ArrivedItemsStrip(items: capture.arrivedItems)
                    .transition(.opacity.combined(with: .offset(y: -24)))
            }
            VStack(spacing: Space.sm) {
                LoopIndicator(people: 3, size: 28)
                Text(detail)
                    .font(Typo.headline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Palette.ink)
                    .id(detail)
                    .transition(.blurReplace.combined(with: .offset(y: 6)))
                Text("You can close this. Items land on your Shelf either way.")
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkTertiary)
            }
            .animation(Motion.soft, value: detail)
            Spacer()
            Spacer()
        }
        .animation(Motion.bouncy, value: hasItems)
    }

    // MARK: Failed

    private func failed(_ message: String) -> some View {
        VStack(spacing: Space.lg) {
            Spacer()
            Image(systemName: "camera.metering.unknown")
                .font(.system(size: 44, weight: .semibold))
                .foregroundStyle(Palette.tangerine)
            Text(message)
                .font(Typo.headline)
                .multilineTextAlignment(.center)
            Button {
                capture.retry()
            } label: {
                PrimaryLabel("Try again", symbol: "arrow.clockwise")
            }
            .buttonStyle(.glassProminent)
            .tint(Palette.ink)
            .padding(.horizontal, Space.xxl)
            Spacer()
        }
    }

    // MARK: Actions

    private func load(_ items: [PhotosPickerItem]) async {
        for item in items {
            if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) {
                if let movie = try? await item.loadTransferable(type: PickedMovie.self) {
                    await capture.add(videoAt: movie.url)
                }
            } else if let data = try? await item.loadTransferable(type: Data.self) {
                await capture.add(imageData: [data])
            }
            capture.settle()
        }
    }

    private func startOver() {
        capture = CaptureModel()
        onFinish()
    }

    private func close() {
        onFinish()
        dismiss()
    }

    /// Offered on the results only when the Shelf can open Tune up.
    private var tuneUpAction: (() -> Void)? {
        guard let onTuneUp else { return nil }
        return {
            onTuneUp()
            close()
        }
    }
}

// MARK: - Source tile

/// A photo still loading: a soft pulsing tile in the photo's place.
private struct PendingTile: View {
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
            .fill(Palette.surface)
            .overlay {
                RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
                    .fill(Palette.ink.opacity(pulse ? 0.08 : 0.03))
            }
            .overlay { ProgressView().tint(Palette.inkTertiary) }
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { pulse = true }
            }
            .accessibilityLabel("Loading photo")
    }
}

private struct SourceTile: View {
    var title: String
    var detail: String
    var symbol: String
    var tint: Color
    var action: () -> Void

    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.md) {
                Image(systemName: symbol)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(width: 56, height: 56)
                    .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(Typo.headline).foregroundStyle(Palette.ink)
                    Text(detail).font(Typo.footnote).foregroundStyle(Palette.inkSecondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(Palette.inkTertiary)
            }
            .padding(Space.md)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .strokeBorder(Palette.hairline, lineWidth: 1)
            }
            .opacity(isEnabled ? 1 : 0.45)
        }
        .buttonStyle(.pressable)
    }
}

// MARK: - Frame deck

/// The photos fanned like a hand of cards, with the appraisal scan sweeping across them in
/// turn while the GM works.
private struct FrameDeck: View {
    var images: [UIImage]
    var scanTick: Int

    @State private var breathe = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            ForEach(Array(images.enumerated()), id: \.offset) { index, image in
                let offset = Double(index) - Double(images.count - 1) / 2
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 170, height: 220)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
                    // Cards take turns: this trigger only changes on ticks that land on this card.
                    .appraiseScan(trigger: max(0, (scanTick - index + images.count) / max(images.count, 1)), duration: 1.8)
                    .overlay {
                        RoundedRectangle(cornerRadius: Radius.tile, style: .continuous)
                            .strokeBorder(.white.opacity(0.6), lineWidth: 2)
                    }
                    .shadow(color: .black.opacity(0.14), radius: 20, y: 12)
                    .rotationEffect(.degrees(offset * (breathe ? 9 : 7)))
                    .offset(x: offset * (breathe ? 34 : 28), y: abs(offset) * 10)
                    .zIndex(-abs(offset))
            }
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 2.4).repeatForever(autoreverses: true)) { breathe = true }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Arrived items

/// Items as the Appraiser names them, dealt in under the deck 1 at a time while it keeps
/// working. Each shows Pricing until its range lands.
private struct ArrivedItemsStrip: View {
    var items: [ShelfItem]

    @State private var dealt: Set<String> = []

    var body: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: Space.sm) {
                ForEach(items.filter { dealt.contains($0.id) }) { item in
                    ArrivedItemCard(item: item)
                        .transition(
                            .asymmetric(
                                insertion: .scale(scale: 0.7, anchor: .top)
                                    .combined(with: .opacity)
                                    .combined(with: .offset(y: -48)),
                                removal: .opacity
                            )
                        )
                }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.vertical, Space.xs)
        }
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
        .padding(.horizontal, -Space.gutter)
        .frame(height: 188)
        .sensoryFeedback(.impact(flexibility: .soft, intensity: 0.5), trigger: dealt.count)
        .task(id: items.map(\.id)) {
            for item in items where !dealt.contains(item.id) {
                withAnimation(Motion.bouncy) { _ = dealt.insert(item.id) }
                do {
                    try await Task.sleep(for: .milliseconds(140))
                } catch {
                    break
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Found so far")
    }
}

private struct ArrivedItemCard: View {
    var item: ShelfItem

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ItemArtwork(item: item, cornerRadius: Radius.small)
                .frame(width: 112, height: 104)
            Text(item.title)
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .foregroundStyle(Palette.ink)
                .lineLimit(2, reservesSpace: true)
            ZStack(alignment: .leading) {
                if let value = item.value {
                    Text(value.label)
                        .font(Typo.caption.monospacedDigit())
                        .foregroundStyle(Palette.inkSecondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .transition(.blurReplace)
                } else if item.isPricing {
                    Text("Pricing")
                        .font(Typo.caption)
                        .foregroundStyle(Palette.inkSecondary)
                        .loopShimmer()
                        .transition(.blurReplace)
                }
            }
            .animation(Motion.soft, value: item.value)
        }
        .frame(width: 112)
        .padding(Space.xs)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.tile, style: .continuous)
                .strokeBorder(Palette.hairline, lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.06), radius: 12, y: 6)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Results

private struct CaptureResults: View {
    var items: [ShelfItem]
    var summary: String
    var onDone: () -> Void
    var onAgain: () -> Void
    var onTuneUp: (() -> Void)?

    @State private var shown = 0

    var body: some View {
        VStack(spacing: Space.lg) {
            if items.isEmpty {
                Spacer()
                Image(systemName: "eye.trianglebadge.exclamationmark")
                    .font(.system(size: 52, weight: .semibold))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(Palette.iris)
                    .symbolEffect(.bounce, value: shown)
            }
            VStack(spacing: Space.xs) {
                Text(items.isEmpty ? "Nothing to trade here" : summary)
                    .font(Typo.title2)
                    .multilineTextAlignment(.center)
                if !items.isEmpty, onTuneUp != nil {
                    Text("A few quick answers help your GM pin each one down.")
                        .font(Typo.callout)
                        .foregroundStyle(Palette.inkSecondary)
                        .multilineTextAlignment(.center)
                } else if items.isEmpty {
                    Text(summary)
                        .font(Typo.callout)
                        .foregroundStyle(Palette.inkSecondary)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(.top, Space.xl)

            if items.isEmpty {
                Spacer()
            }
            ScrollView {
                VStack(spacing: Space.sm) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        if index < shown {
                            ResultRow(item: item)
                                .transition(.scale(scale: 0.9).combined(with: .opacity).combined(with: .offset(y: 12)))
                        }
                    }
                }
                .padding(.vertical, Space.xs)
            }
            .scrollIndicators(.hidden)
            .frame(maxHeight: items.isEmpty ? 0 : .infinity)

            VStack(spacing: Space.sm) {
                if let onTuneUp, !items.isEmpty {
                    Button(action: onTuneUp) {
                        PrimaryLabel("Tune up now, about 1 minute", symbol: "wand.and.stars")
                            .frame(height: 48)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(Palette.ink)
                    Button(action: onDone) {
                        Text("See your Shelf")
                            .font(.system(size: 17, weight: .bold, design: .rounded))
                            .foregroundStyle(Palette.ink)
                            .frame(maxWidth: .infinity)
                            .frame(height: 40)
                    }
                    .buttonStyle(.glass)
                } else {
                    Button(action: onDone) {
                        PrimaryLabel(items.isEmpty ? "Close" : "See your Shelf", symbol: items.isEmpty ? nil : "square.grid.2x2")
                            .frame(height: 48)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(Palette.ink)
                }
                Button(items.isEmpty ? "Try other photos" : "Add more", action: onAgain)
                    .font(Typo.callout)
                    .foregroundStyle(Palette.inkSecondary)
            }
            .padding(.bottom, Space.lg)
        }
        .task {
            // Deal the cards in 1 at a time.
            for i in 1...max(items.count, 1) {
                withAnimation(Motion.bouncy) { shown = i }
                try? await Task.sleep(for: .milliseconds(140))
            }
        }
    }
}

private struct ResultRow: View {
    var item: ShelfItem

    var body: some View {
        HStack(spacing: Space.md) {
            ItemArtwork(item: item, cornerRadius: Radius.small)
                .frame(width: 64, height: 64)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .lineLimit(2)
                if let value = item.value {
                    Text(value.label)
                        .font(Typo.value)
                        .foregroundStyle(Palette.inkSecondary)
                } else if item.isPricing {
                    Text("Pricing")
                        .font(Typo.value)
                        .foregroundStyle(Palette.inkSecondary)
                        .loopShimmer()
                }
                ReadinessMark(readiness: item.readiness, isWorking: item.isAppraising)
            }
            Spacer(minLength: 0)
        }
        .padding(Space.sm)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.tile, style: .continuous)
                .strokeBorder(Palette.hairline, lineWidth: 1)
        }
    }
}

// MARK: - Pickers

/// A video from the photo library, copied somewhere we own before the picker deletes it.
nonisolated struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let destination = FileManager.default.temporaryDirectory
                .appending(path: "\(UUID().uuidString).\(received.file.pathExtension)")
            try FileManager.default.copyItem(at: received.file, to: destination)
            return PickedMovie(url: destination)
        }
    }
}

/// The system camera, for 1 photo or a video up to 60 seconds. `allowsVideo: false` is
/// photos only, for answering the GM's photo request.
struct CameraPicker: UIViewControllerRepresentable {
    enum Result {
        case photo(Data)
        case video(URL)
    }

    var allowsVideo = true
    var onCapture: (Result) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        if allowsVideo {
            picker.mediaTypes = [UTType.movie.identifier, UTType.image.identifier]
            picker.cameraCaptureMode = .video
            picker.videoMaximumDuration = 60
            picker.videoQuality = .typeHigh
        } else {
            picker.mediaTypes = [UTType.image.identifier]
            picker.cameraCaptureMode = .photo
        }
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker

        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let url = info[.mediaURL] as? URL {
                let destination = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).\(url.pathExtension)")
                if (try? FileManager.default.copyItem(at: url, to: destination)) != nil {
                    parent.onCapture(.video(destination))
                }
            } else if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.92) {
                parent.onCapture(.photo(data))
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
