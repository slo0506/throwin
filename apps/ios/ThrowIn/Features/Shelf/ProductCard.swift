import SwiftUI
import UIKit

/// What a tap on any Shelf Item opens, and the only page an Item has: its photos, what the
/// GM thinks it is, what it's worth, and 1 card where the GM says what it needs next and
/// asks for it (a question, specific photos, or a label shot). Whether you'd trade it sits
/// below; edit and remove live in the menu.
///
/// The photos are a carousel, the best one first. The scan only plays while the GM is
/// actually looking at them.
struct ProductPage: View {
    var itemID: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var shoot: ShootRoute?
    @State private var viewer: PhotoViewerRoute?
    @State private var isEditing = false
    @State private var confirmRemove = false
    @State private var answers = 0

    private var item: ShelfItem? { model.shelf.first { $0.id == itemID } }

    var body: some View {
        NavigationStack {
            ScrollView {
                if let item {
                    VStack(alignment: .leading, spacing: Space.xl) {
                        ItemPhotoCarousel(item: item) { index in
                            viewer = PhotoViewerRoute(urls: item.carouselUrls, index: index)
                        }
                        identity(item)
                        GMNextStepCard(
                            item: item,
                            question: model.topQuestion(for: item.id),
                            onAnswer: { question, answer in
                                answers += 1
                                Task { await model.answer(question, with: answer) }
                            },
                            onShoot: { angles in shoot = ShootRoute(angles: angles) },
                            onEdit: { isEditing = true }
                        )
                        details(item)
                        VStack(alignment: .leading, spacing: Space.sm) {
                            SectionHeader(title: "Would you trade it?")
                            WillingnessPicker(selection: willingnessBinding(for: item))
                        }
                    }
                    .padding(.horizontal, Space.gutter)
                    .padding(.top, Space.xs)
                    .padding(.bottom, Space.xxl)
                    .animation(Motion.soft, value: item.isAppraising)
                    .animation(Motion.soft, value: item.value)
                    .animation(Motion.bouncy, value: item.readiness)
                }
            }
            .scrollIndicators(.hidden)
            .background(Palette.canvas)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(Radius.card + 8)
        .quietBanner()
        .fullScreenCover(item: $shoot) { route in
            ShowcaseShootView(itemID: itemID, angles: route.angles)
        }
        .fullScreenCover(item: $viewer) { route in
            PhotoViewer(urls: route.urls, index: route.index)
        }
        .sheet(isPresented: $isEditing) {
            if let item {
                ItemEditSheet(item: item) { title, grade in
                    model.editItem(item.id, title: title, conditionGrade: grade)
                }
            }
        }
        .confirmationDialog(
            "Remove \(item?.title ?? "this item")?",
            isPresented: $confirmRemove,
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                dismiss()
                Task {
                    try? await Task.sleep(for: .milliseconds(350))
                    model.removeItem(itemID)
                }
            }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: answers)
        .onChange(of: item == nil) { _, isGone in
            // Removed, or removed by another device.
            if isGone { dismiss() }
        }
        .task(id: item?.openQuestions ?? 0) {
            guard let item, item.openQuestions > 0, model.topQuestion(for: item.id) == nil else { return }
            await model.loadQuestions(for: item.id)
        }
        .task(id: item?.isAppraising ?? false) {
            // Opened while the GM is still working: follow it here. No-op if already followed.
            guard item?.isAppraising == true else { return }
            await model.followAppraisal(itemID)
        }
    }

    /// Both on the right, like Maps and Find My: more actions, then close.
    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("Fix name or condition", systemImage: "pencil") { isEditing = true }
                    .disabled(item?.isReserved ?? true)
                Button("Remove from Shelf", systemImage: "trash", role: .destructive) { confirmRemove = true }
                    .disabled(item?.isReserved ?? true)
            } label: {
                Image(systemName: "ellipsis")
            }
            .accessibilityLabel("More actions")
        }
        ToolbarSpacer(.fixed, placement: .topBarTrailing)
        ToolbarItem(placement: .topBarTrailing) {
            Button("Close", systemImage: "xmark") { dismiss() }
        }
    }

    // MARK: What it is

    private func identity(_ item: ShelfItem) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            VStack(alignment: .leading, spacing: Space.xs) {
                HStack(spacing: Space.xs) {
                    Pill(text: item.readiness.confidencePhrase, symbol: "sparkles", tint: Palette.iris)
                    if item.isReserved {
                        Pill(text: "In a pending deal", symbol: "lock.fill", tint: Palette.give)
                    }
                }
                Text(item.title)
                    .font(Typo.title2)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .contentTransition(.opacity)
            }
            facts(item)
            worth(item)
        }
    }

    @ViewBuilder
    private func facts(_ item: ShelfItem) -> some View {
        let words = [item.brand, item.model, item.variant]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if !words.isEmpty || item.conditionGrade != nil {
            FlowRow(spacing: Space.xs) {
                if let grade = item.conditionGrade {
                    GradeChip(grade: grade)
                }
                ForEach(words, id: \.self) { word in
                    Pill(text: word)
                }
            }
        }
    }

    @ViewBuilder
    private func worth(_ item: ShelfItem) -> some View {
        if let value = item.value {
            VStack(alignment: .leading, spacing: 6) {
                (Text("Worth about ").foregroundStyle(Palette.inkSecondary) + Text(value.label).foregroundStyle(Palette.ink))
                    .font(Typo.value)
                    .contentTransition(.numericText())
                ValueRangeBar(range: value, tint: ArtworkStyle(category: item.category).tint, showsLabels: false)
            }
            .padding(.top, Space.xxs)
            .transition(.blurReplace)
        } else if item.isPricing {
            VStack(alignment: .leading, spacing: 6) {
                Text("Pricing")
                    .font(Typo.value)
                    .foregroundStyle(Palette.inkSecondary)
                    .loopShimmer()
                PricingPlaceholder(showsLabels: false)
            }
            .padding(.top, Space.xxs)
            .transition(.blurReplace)
        }
    }

    // MARK: Details

    @ViewBuilder
    private func details(_ item: ShelfItem) -> some View {
        let description = item.itemDescription?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !description.isEmpty || !item.defects.isEmpty {
            VStack(alignment: .leading, spacing: Space.sm) {
                SectionHeader(title: "What your GM sees")
                if !description.isEmpty {
                    Text(description)
                        .font(Typo.body)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !item.defects.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(item.defects, id: \.self) { defect in
                            Label(defect, systemImage: "exclamationmark.circle")
                                .font(Typo.callout)
                                .foregroundStyle(Palette.inkSecondary)
                        }
                    }
                }
                Text("What the photos show. Your GM never says an item is genuine.")
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkTertiary)
            }
        }
    }

    private func willingnessBinding(for item: ShelfItem) -> Binding<Willingness> {
        Binding(
            get: { model.shelf.first { $0.id == item.id }?.willingness ?? item.willingness },
            set: { model.setWillingness($0, for: item.id) }
        )
    }
}

/// Which angles a Showcase shoot walks through.
struct ShootRoute: Identifiable {
    let id = UUID()
    var angles: [String]
}

// MARK: - The GM's next step

/// The GM's card on the product page: where the Item is (the readiness meter), the GM's
/// read on its photo in plain words, and exactly 1 next step it's asking for. Never a dead
/// end: when it has no question, it asks for the photo that would settle what it is.
struct GMNextStepCard: View {
    var item: ShelfItem
    var question: Question?
    var onAnswer: (Question, String) -> Void
    var onShoot: ([String]) -> Void
    var onEdit: () -> Void

    var body: some View {
        PaperCard {
            VStack(alignment: .leading, spacing: Space.md) {
                HStack(spacing: Space.xs) {
                    GMOrbView(mood: item.isAppraising ? .thinking : .idle, size: 22, showsGlow: false)
                    Text("Your GM").sectionLabel()
                }
                ReadinessMeter(readiness: item.readiness)
                step
                    .transition(.asymmetric(
                        insertion: .move(edge: .bottom).combined(with: .opacity),
                        removal: .opacity
                    ))
            }
        }
        .animation(Motion.soft, value: stepKey)
    }

    /// Identity for the transition between steps.
    private var stepKey: String {
        if item.isAppraising { return "working" }
        if let question { return "q-\(question.id)" }
        return "r-\(item.readiness.rawValue)-\(item.missingAngles.joined())"
    }

    @ViewBuilder
    private var step: some View {
        if item.isAppraising {
            HStack(spacing: Space.sm) {
                LoopIndicator(people: 3, size: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Taking another look")
                        .font(Typo.headline)
                        .foregroundStyle(Palette.ink)
                        .loopShimmer()
                    Text("Going over what's new. This takes a few seconds.")
                        .font(Typo.footnote)
                        .foregroundStyle(Palette.inkSecondary)
                }
            }
        } else if let question {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text(question.prompt)
                    .font(Typo.headline)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                QuestionAnswerControls(
                    question: question,
                    onAnswer: { onAnswer(question, $0) },
                    onPhoto: { onShoot([question.photoAngle]) }
                )
                Text("Each answer narrows what it's worth.")
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkTertiary)
            }
            .id(question.id)
        } else {
            switch item.readiness {
            case .showcase:
                message(
                    "Ready to show",
                    "People in your Circles see these photos when I put it in a deal. Nothing to do here."
                )
            case .identified:
                photoRequest
            case .logged:
                VStack(alignment: .leading, spacing: Space.sm) {
                    message(
                        "Help me pin it down",
                        "A photo of the label, tag or model number usually settles it. Or tell me what it is."
                    )
                    shootButton("Photo of the label", angles: ["Label or tag"])
                    Button("I know what it is", action: onEdit)
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(Palette.ink)
                        .frame(maxWidth: .infinity)
                        .frame(height: 36)
                        .disabled(item.isReserved)
                }
            }
        }
    }

    /// Identified: the angles still missing, how the current photo does, and 1 button.
    private var photoRequest: some View {
        let angles = item.showcaseAngles
        let count = angles.count
        return VStack(alignment: .leading, spacing: Space.sm) {
            message(
                count == 1 ? "1 photo and it's ready to show" : "\(count) photos and it's ready to show",
                "I need \(Self.spokenList(angles))."
            )
            if let grade = photoGrade {
                tip(grade, symbol: "camera.metering.center.weighted")
            }
            ForEach(coaching, id: \.self) { line in
                tip(line, symbol: "lightbulb")
            }
            shootButton(count == 1 ? "Take 1 photo" : "Take \(count) photos", angles: angles)
        }
    }

    private func tip(_ text: String, symbol: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.xs) {
            Image(systemName: symbol)
                .frame(width: 22)
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(Typo.callout)
        .foregroundStyle(Palette.inkSecondary)
    }

    /// "the back and any label": angle labels read as part of a sentence.
    static func spokenList(_ labels: [String]) -> String {
        let words = labels.map { label in
            // Keep acronyms like "USB ports"; lowercase the rest.
            let first = label.split(separator: " ").first.map(String.init) ?? label
            return first == first.uppercased() && first.count > 1 ? label : label.lowercased()
        }
        switch words.count {
        case 0: return "a couple more angles"
        case 1: return words[0]
        default: return words.dropLast().joined(separator: ", ") + " and " + (words.last ?? "")
        }
    }

    private func message(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(Typo.headline)
                .foregroundStyle(Palette.ink)
            Text(detail)
                .font(Typo.callout)
                .foregroundStyle(Palette.inkSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func shootButton(_ title: String, angles: [String]) -> some View {
        Button {
            onShoot(angles)
        } label: {
            PrimaryLabel(title, symbol: "camera.aperture")
                .frame(height: 48)
        }
        .buttonStyle(.glassProminent)
        .tint(Palette.ink)
        .disabled(item.isReserved)
    }

    /// The GM's grade for the best photo, in words. Never the score.
    private var photoGrade: String? {
        guard let score = item.photoScore else { return nil }
        switch score {
        case ..<50: return "Your photo works for logging, but nobody would trade from it."
        case 50..<75: return "Your photo is usable. The missing angles are what's left."
        default: return "Your photo looks good."
        }
    }

    /// 1 tip per problem the GM saw in the photo.
    private var coaching: [String] {
        item.photoIssues.compactMap { issue in
            switch issue {
            case "too_small": "It's small in the frame. Get closer so it fills the photo."
            case "blurry": "It's a little blurry. Hold steady, or tap the screen to focus."
            case "dark": "It's dark. Shoot near a window or under a bright light."
            case "cut_off": "Part of it is cut off. Step back so all of it shows."
            case "cluttered_background": "There's a lot behind it. A plain wall or table works best."
            default: nil
            }
        }
    }
}

// MARK: - Photos

extension ShelfItem {
    /// Every photo for the carousel, the best first. Falls back to the thumbnail.
    var carouselUrls: [URL] {
        let urls = photoUrls.compactMap(URL.init(string:))
        if !urls.isEmpty { return urls }
        return thumbnailUrl.flatMap(URL.init(string:)).map { [$0] } ?? []
    }
}

/// The Item's photos as a swipeable carousel. The first (best) photo can switch to Studio
/// when it's good enough; the "Inventory photo" tag marks a first photo below the floor.
struct ItemPhotoCarousel: View {
    var item: ShelfItem
    var onOpen: (Int) -> Void

    @State private var page = 0
    @State private var studioImage: UIImage?
    @State private var showsOriginal = false

    var body: some View {
        let urls = item.carouselUrls
        let shape = RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
        ZStack {
            if urls.count > 1 {
                TabView(selection: $page) {
                    ForEach(Array(urls.enumerated()), id: \.offset) { index, url in
                        photo(url, index: index)
                            .tag(index)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
            } else {
                ItemArtwork(item: item, cornerRadius: 0, symbolScale: 0.3, studio: studioMode)
                    .contentShape(Rectangle())
                    .onTapGesture { if !urls.isEmpty { onOpen(0) } }
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .clipShape(shape)
        .appraiseScan(while: item.isAppraising, duration: 1.8)
        .shadow(color: .black.opacity(0.08), radius: 24, y: 12)
        .overlay(alignment: .topLeading) {
            if page == 0, item.hasInventoryPhoto, studioImage == nil || showsOriginal {
                InventoryPhotoTag()
                    .padding(Space.sm)
                    .transition(.opacity)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if page == 0, studioImage != nil {
                StudioToggle(showsOriginal: $showsOriginal)
                    .padding(Space.sm)
                    .transition(.scale(scale: 0.8).combined(with: .opacity))
            }
        }
        .overlay(alignment: .bottom) {
            if urls.count > 1 {
                PageDots(count: urls.count, page: page)
                    .padding(.bottom, Space.sm)
            }
        }
        .animation(Motion.soft, value: showsOriginal)
        .animation(Motion.snappy, value: page)
        .animation(Motion.bouncy, value: studioImage != nil)
        .task(id: StudioKey(url: item.thumbnailUrl, allowed: item.studioAllowed)) {
            await loadStudio()
        }
        .onChange(of: urls.count) { _, count in
            if page >= count { page = 0 }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(urls.count > 1 ? "\(urls.count) photos" : "Photo")
    }

    private var studioMode: StudioMode {
        if let studioImage, !showsOriginal { .show(studioImage) } else { .off }
    }

    @ViewBuilder
    private func photo(_ url: URL, index: Int) -> some View {
        ZStack {
            if index == 0 {
                ItemArtwork(item: item, cornerRadius: 0, symbolScale: 0.3, studio: studioMode)
            } else {
                Palette.surface
                RemoteImage(url: url)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { onOpen(index) }
    }

    /// Studio only when the photo is good enough and Vision finds a clean subject.
    private func loadStudio() async {
        guard item.studioAllowed, let url = item.thumbnailUrl.flatMap(URL.init(string:)) else {
            studioImage = nil
            return
        }
        if let cached = StudioCache.cached(url) {
            studioImage = cached
            return
        }
        studioImage = nil
        guard let made = await StudioCache.studio(for: url), !Task.isCancelled else { return }
        withAnimation(Motion.soft) { studioImage = made }
    }
}

/// Small capsule dots for a photo carousel, the current page stretched.
struct PageDots: View {
    var count: Int
    var page: Int

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<count, id: \.self) { index in
                Capsule()
                    .fill(index == page ? Color.white : Color.white.opacity(0.5))
                    .frame(width: index == page ? 16 : 6, height: 6)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(.black.opacity(0.25), in: Capsule())
        .animation(Motion.snappy, value: page)
        .accessibilityHidden(true)
    }
}

struct PhotoViewerRoute: Identifiable {
    let id = UUID()
    var urls: [URL]
    var index: Int
}

/// Full-screen photos on black, swipe between them, pinch to look closer.
struct PhotoViewer: View {
    var urls: [URL]
    @State var index: Int

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            TabView(selection: $index) {
                ForEach(Array(urls.enumerated()), id: \.offset) { offset, url in
                    ZoomablePhoto(url: url)
                        .tag(offset)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: urls.count > 1 ? .automatic : .never))
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .circle)
            .padding(Space.md)
            .accessibilityLabel("Close")
        }
        .statusBarHidden()
    }
}

/// 1 photo that fits the screen and zooms with a pinch, springing back on release.
private struct ZoomablePhoto: View {
    var url: URL
    @State private var image: UIImage?
    @GestureState private var pinch: CGFloat = 1

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(max(1, pinch))
                    .gesture(MagnifyGesture().updating($pinch) { value, state, _ in
                        state = value.magnification
                    })
                    .animation(Motion.snappy, value: pinch == 1)
            } else {
                LoopIndicator(people: 3, size: 28)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: url) {
            image = await ThumbnailCache.image(for: url)
        }
    }
}

// MARK: - Shared pieces

/// A small glass switch between the studio presentation and the original photo.
struct StudioToggle: View {
    @Binding var showsOriginal: Bool
    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 2) {
            option("Studio", isSelected: !showsOriginal) { showsOriginal = false }
            option("Original", isSelected: showsOriginal) { showsOriginal = true }
        }
        .padding(3)
        .glassEffect(.regular.interactive(), in: .capsule)
        .sensoryFeedback(.selection, trigger: showsOriginal)
    }

    private func option(_ title: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button {
            withAnimation(Motion.snappy) { action() }
        } label: {
            Text(title)
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .foregroundStyle(isSelected ? Palette.ink : Palette.inkSecondary)
                .padding(.horizontal, 12)
                .frame(height: 30)
                .background {
                    if isSelected {
                        Capsule()
                            .fill(Palette.surface.opacity(0.92))
                            .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
                            .matchedGeometryEffect(id: "thumb", in: thumb)
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// Reloads Studio when the photo changes or Studio becomes allowed.
struct StudioKey: Hashable {
    var url: String?
    var allowed: Bool
}

/// 3-way segmented control with a sliding glass thumb.
struct WillingnessPicker: View {
    @Binding var selection: Willingness
    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Willingness.allCases, id: \.self) { option in
                let isSelected = option == selection
                Button {
                    withAnimation(Motion.bouncy) { selection = option }
                } label: {
                    HStack(spacing: 6) {
                        WillingnessDot(willingness: option)
                        Text(option.label)
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .foregroundStyle(isSelected ? Palette.ink : Palette.inkSecondary)
                    .frame(maxWidth: .infinity)
                    .frame(height: 44)
                    .background {
                        if isSelected {
                            Capsule()
                                .fill(Palette.surface)
                                .shadow(color: .black.opacity(0.08), radius: 8, y: 3)
                                .matchedGeometryEffect(id: "thumb", in: thumb)
                        }
                    }
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(Palette.ink.opacity(0.06), in: Capsule())
        .sensoryFeedback(.selection, trigger: selection)
    }
}
