import SwiftUI
import UIKit

/// What a tap on any Shelf card opens: the best photo, what the GM thinks it is, a short
/// description, key facts, the value range, the readiness steps and exactly 1 next step.
/// "More" goes on to the full Item detail.
struct ProductCardSheet: View {
    var itemID: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var detent: PresentationDetent = .medium
    @State private var showsDetail = false
    @State private var shoot: ShootRoute?
    @State private var studioImage: UIImage?
    @State private var showsOriginal = false
    @State private var scan = 0
    @State private var answers = 0

    private var item: ShelfItem? { model.shelf.first { $0.id == itemID } }

    var body: some View {
        NavigationStack {
            ScrollView {
                if let item {
                    VStack(alignment: .leading, spacing: Space.lg) {
                        hero(item)
                        identity(item)
                        facts(item)
                        worth(item)
                        nextStep(item)
                        more
                    }
                    .padding(.horizontal, Space.gutter)
                    .padding(.top, Space.lg)
                    .padding(.bottom, Space.xxl)
                    .animation(Motion.soft, value: item.isAppraising)
                    .animation(Motion.soft, value: item.value)
                    .animation(Motion.bouncy, value: item.readiness)
                }
            }
            .scrollIndicators(.hidden)
            .background(Palette.canvas)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(isPresented: $showsDetail) {
                ItemDetailView(itemID: itemID)
            }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(Radius.card + 8)
        .quietBanner()
        .fullScreenCover(item: $shoot) { route in
            ShowcaseShootView(itemID: itemID, angles: route.angles)
        }
        .sensoryFeedback(.impact(weight: .light), trigger: answers)
        .onChange(of: item == nil) { _, isGone in
            // Removed from the full detail, or by another device.
            if isGone { dismiss() }
        }
        .task {
            try? await Task.sleep(for: .milliseconds(320))
            scan += 1
        }
        .task(id: item?.openQuestions ?? 0) {
            guard let item, item.openQuestions > 0, model.topQuestion(for: item.id) == nil else { return }
            await model.loadQuestions(for: item.id)
        }
        .task(id: StudioKey(url: item?.thumbnailUrl, allowed: item?.studioAllowed ?? false)) {
            await loadStudio()
        }
        .task(id: item?.isAppraising ?? false) {
            // Opened while the GM is still working: follow it here. No-op if already followed.
            guard item?.isAppraising == true else { return }
            await model.followAppraisal(itemID)
        }
    }

    // MARK: Photo

    private func hero(_ item: ShelfItem) -> some View {
        let studio: StudioMode = if let studioImage, !showsOriginal { .show(studioImage) } else { .off }
        let showsStudio = studioImage != nil && !showsOriginal
        return VStack(alignment: .leading, spacing: Space.xs) {
            ItemArtwork(item: item, cornerRadius: Radius.card, symbolScale: 0.3, studio: studio)
                .aspectRatio(4.0 / 3.0, contentMode: .fit)
                .appraiseScan(trigger: scan, duration: 1.6)
                .shadow(color: .black.opacity(0.08), radius: 24, y: 12)
                .overlay(alignment: .topLeading) {
                    if item.hasInventoryPhoto, !showsStudio {
                        InventoryPhotoTag()
                            .padding(Space.sm)
                            .transition(.opacity)
                    }
                }
                .overlay(alignment: .bottomTrailing) {
                    if studioImage != nil {
                        StudioToggle(showsOriginal: $showsOriginal)
                            .padding(Space.sm)
                            .transition(.scale(scale: 0.8).combined(with: .opacity))
                    }
                }
                .animation(Motion.soft, value: showsOriginal)
                .animation(Motion.bouncy, value: studioImage != nil)

            if !item.studioAllowed, item.thumbnailUrl != nil {
                Label("Studio needs a sharper, closer photo.", systemImage: "camera.metering.center.weighted")
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkSecondary)
                    .padding(.horizontal, 4)
            }
        }
    }

    /// Studio only when the photo is good enough and Vision finds a clean subject.
    private func loadStudio() async {
        guard item?.studioAllowed == true, let url = item?.thumbnailUrl.flatMap(URL.init(string:)) else {
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

    // MARK: What it is

    private func identity(_ item: ShelfItem) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Pill(text: item.readiness.confidencePhrase, symbol: "sparkles", tint: Palette.iris)
                .contentTransition(.opacity)
            Text(item.title)
                .font(Typo.title2)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .contentTransition(.opacity)
            if let description = item.itemDescription, !description.isEmpty {
                Text(description)
                    .font(Typo.body)
                    .foregroundStyle(Palette.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
            }
        }
    }

    @ViewBuilder
    private func facts(_ item: ShelfItem) -> some View {
        let words = [item.brand, item.model, item.variant]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if !words.isEmpty || item.conditionGrade != nil {
            ScrollView(.horizontal) {
                HStack(spacing: Space.xs) {
                    ForEach(words, id: \.self) { word in
                        Pill(text: word)
                    }
                    if let grade = item.conditionGrade {
                        GradeChip(grade: grade)
                    }
                }
                .padding(.horizontal, Space.gutter)
            }
            .scrollIndicators(.hidden)
            .padding(.horizontal, -Space.gutter)
        }
    }

    @ViewBuilder
    private func worth(_ item: ShelfItem) -> some View {
        if let value = item.value {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text("Worth about").sectionLabel()
                Text(value.label)
                    .font(Typo.valueLarge)
                    .foregroundStyle(Palette.ink)
                    .contentTransition(.numericText())
                ValueRangeBar(range: value, tint: ArtworkStyle(category: item.category).tint)
            }
            .transition(.blurReplace)
        } else if item.isPricing {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text("Worth about").sectionLabel()
                PricingPlaceholder()
            }
            .transition(.blurReplace)
        }
    }

    // MARK: Next step

    private func nextStep(_ item: ShelfItem) -> some View {
        PaperCard {
            VStack(alignment: .leading, spacing: Space.md) {
                ReadinessMeter(readiness: item.readiness)

                if item.isAppraising {
                    HStack(spacing: Space.sm) {
                        LoopIndicator(people: 3, size: 22)
                        Text("Your GM is updating this item.")
                            .font(Typo.callout)
                            .foregroundStyle(Palette.ink)
                            .loopShimmer()
                    }
                    .transition(.blurReplace)
                } else {
                    Text(item.nextStepLine)
                        .font(Typo.callout)
                        .foregroundStyle(Palette.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentTransition(.opacity)
                    primaryAction(item)
                }
            }
        }
    }

    /// Exactly 1 next best step: the top open question, else the showcase shoot when the
    /// Item is identified, else nothing.
    @ViewBuilder
    private func primaryAction(_ item: ShelfItem) -> some View {
        if let question = model.topQuestion(for: item.id) {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text(question.prompt)
                    .font(Typo.headline)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                QuestionAnswerControls(
                    question: question,
                    onAnswer: { answer in
                        answers += 1
                        Task { await model.answer(question, with: answer) }
                    },
                    onPhoto: { shoot = ShootRoute(angles: [question.photoAngle]) }
                )
            }
            .id(question.id)
            .transition(.asymmetric(
                insertion: .move(edge: .bottom).combined(with: .opacity),
                removal: .scale(scale: 0.9).combined(with: .opacity)
            ))
        } else if item.readiness == .identified {
            Button {
                shoot = ShootRoute(angles: item.showcaseAngles)
            } label: {
                PrimaryLabel("Start the showcase shoot", symbol: "camera.aperture")
                    .frame(height: 48)
            }
            .buttonStyle(.glassProminent)
            .tint(Palette.ink)
            .transition(.blurReplace)
        }
    }

    private var more: some View {
        Button {
            withAnimation(Motion.soft) { detent = .large }
            showsDetail = true
        } label: {
            HStack(spacing: 4) {
                Text("More")
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .bold))
            }
            .font(Typo.callout)
            .foregroundStyle(Palette.inkSecondary)
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Edit, set whether you'd trade it, or remove it")
    }
}

/// Which angles a Showcase shoot walks through.
struct ShootRoute: Identifiable {
    let id = UUID()
    var angles: [String]
}
