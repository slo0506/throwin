import SwiftUI

/// Tune up: a stack of quick questions across the Shelf (or 1 Item), best first. Answer with
/// a tap, swipe left or tap Skip to pass. Answers post in the background; if 1 fails, the
/// quiet banner says so and its card comes back.
struct TuneUpView: View {
    /// nil for the whole Shelf.
    var itemID: String?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var deck: [Question] = []
    @State private var isLoading = true
    /// Item IDs, 1 per answer given, so a failed save can take its answer back.
    @State private var answeredItems: [String] = []
    @State private var drag: CGSize = .zero
    @State private var flyOut: CGSize = .zero
    @State private var flyTilt: Double = 0
    @State private var isAdvancing = false
    @State private var tick = 0
    @State private var shootFor: Question?
    /// Height of the front card, so the cards peeking behind it match it exactly.
    @State private var frontHeight: CGFloat = 0

    private static let swipeDistance: CGFloat = 110
    private static let visibleCards = 3

    var body: some View {
        ZStack {
            Palette.canvas.ignoresSafeArea()

            VStack(spacing: Space.lg) {
                topBar
                Spacer(minLength: 0)
                if isLoading {
                    loading
                        .transition(.blurReplace)
                } else if deck.isEmpty {
                    summary
                        .transition(.blurReplace.combined(with: .scale(0.96)))
                } else {
                    stack
                        .transition(.opacity)
                    skipButton
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.lg)
            .animation(Motion.soft, value: isLoading)
            .animation(Motion.soft, value: deck.isEmpty)
        }
        .quietBanner()
        .sensoryFeedback(.impact(weight: .light), trigger: tick)
        .fullScreenCover(item: $shootFor) { question in
            ShowcaseShootView(itemID: question.itemId, angles: [question.photoAngle]) { sent in
                guard sent else { return }
                answeredItems.append(question.itemId)
                advance(skipping: false)
            }
        }
        .task { await load() }
    }

    // MARK: Parts

    private var topBar: some View {
        HStack {
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
            Spacer()
            VStack(spacing: 0) {
                Text("Tune up")
                    .font(Typo.headline)
                if !deck.isEmpty {
                    Text(deck.count == 1 ? "1 question left" : "\(deck.count) questions left")
                        .font(Typo.footnote.monospacedDigit())
                        .foregroundStyle(Palette.inkSecondary)
                        .contentTransition(.numericText())
                }
            }
            .animation(Motion.snappy, value: deck.count)
            Spacer()
            Color.clear.frame(width: 44, height: 44)
        }
        .padding(.top, Space.xs)
    }

    private var loading: some View {
        VStack(spacing: Space.md) {
            LoopIndicator(people: 3, size: 36)
            Text("Finding the quickest questions")
                .font(Typo.callout)
                .foregroundStyle(Palette.inkSecondary)
        }
    }

    private var stack: some View {
        ZStack(alignment: .top) {
            // Cards behind are plain outlines the size of the front card, so a taller
            // question waiting in the deck never pokes out under a shorter one.
            ForEach(1..<max(1, min(deck.count, Self.visibleCards)), id: \.self) { depth in
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .fill(Palette.surface)
                    .shadow(color: .black.opacity(0.05), radius: 12, y: 4)
                    .frame(height: frontHeight)
                    .scaleEffect(x: 1 - CGFloat(depth) * 0.05, y: 1, anchor: .bottom)
                    .offset(y: CGFloat(depth) * 12)
                    .opacity(1 - Double(depth) * 0.3)
                    .zIndex(-Double(depth))
                    .allowsHitTesting(false)
            }
            if let question = deck.first {
                QuestionCard(
                    question: question,
                    item: model.shelf.first { $0.id == question.itemId },
                    skipHint: min(1, max(0, -drag.width / Self.swipeDistance)),
                    onAnswer: { answer($0, to: question) },
                    onPhoto: { shootFor = question }
                )
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { frontHeight = $0 }
                .offset(x: drag.width + flyOut.width, y: drag.height + flyOut.height)
                .rotationEffect(.degrees(Double(drag.width) / 20 + flyTilt))
                .allowsHitTesting(!isAdvancing)
                .gesture(swipe)
                .id(question.id)
                .transition(.asymmetric(
                    insertion: .move(edge: .bottom).combined(with: .opacity),
                    removal: .opacity
                ))
            }
        }
        .animation(Motion.soft, value: frontHeight)
        .frame(maxWidth: .infinity)
    }

    private var skipButton: some View {
        Button("Skip") {
            guard let question = deck.first else { return }
            skip(question)
        }
        .font(.system(size: 16, weight: .semibold, design: .rounded))
        .foregroundStyle(Palette.inkSecondary)
        .frame(height: 44)
        .padding(.horizontal, Space.lg)
        .disabled(isAdvancing)
    }

    private var summary: some View {
        let answers = answeredItems.count
        let items = Set(answeredItems).count
        return VStack(spacing: Space.lg) {
            Image(systemName: answers > 0 ? "checkmark.seal.fill" : "sparkles")
                .font(.system(size: 52, weight: .semibold))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(answers > 0 ? Palette.mint : Palette.iris)
                .symbolEffect(.bounce, value: answers)
            VStack(spacing: Space.xs) {
                Text(answers > 0 ? summaryLine(answers: answers, items: items) : "All caught up")
                    .font(Typo.title2)
                    .multilineTextAlignment(.center)
                Text(answers > 0
                     ? "Your GM is updating those items now."
                     : "Nothing to ask right now. New questions show up as your GM looks closer.")
                    .font(Typo.callout)
                    .foregroundStyle(Palette.inkSecondary)
                    .multilineTextAlignment(.center)
            }
            Button {
                dismiss()
            } label: {
                PrimaryLabel("Done")
                    .frame(height: 48)
            }
            .buttonStyle(.glassProminent)
            .tint(Palette.ink)
            .padding(.horizontal, Space.xl)
        }
    }

    /// "3 answers, 2 items sharper"
    private func summaryLine(answers: Int, items: Int) -> String {
        "\(answers) \(answers == 1 ? "answer" : "answers"), \(items) \(items == 1 ? "item" : "items") sharper"
    }

    // MARK: Gestures

    private var swipe: some Gesture {
        DragGesture(minimumDistance: 14)
            .onChanged { value in
                guard !isAdvancing else { return }
                drag = CGSize(width: min(value.translation.width, 60), height: value.translation.height * 0.15)
            }
            .onEnded { value in
                guard !isAdvancing, let question = deck.first else { return }
                if value.translation.width < -Self.swipeDistance || value.predictedEndTranslation.width < -Self.swipeDistance * 2.4 {
                    skip(question)
                } else {
                    withAnimation(Motion.bouncy) { drag = .zero }
                }
            }
    }

    // MARK: Actions

    private func load() async {
        let initial = scoped(model.questions)
        if !initial.isEmpty {
            deck = initial
            isLoading = false
        }
        await model.loadQuestions(for: itemID)
        // Only take the fresh list if nothing has been answered yet, so cards never jump.
        if answeredItems.isEmpty, !isAdvancing, deck == initial {
            withAnimation(Motion.soft) { deck = scoped(model.questions) }
        }
        isLoading = false
    }

    private func scoped(_ questions: [Question]) -> [Question] {
        guard let itemID else { return questions }
        return questions.filter { $0.itemId == itemID }
    }

    private func answer(_ text: String, to question: Question) {
        guard !isAdvancing else { return }
        answeredItems.append(question.itemId)
        advance(skipping: false)
        Task {
            if await model.answer(question, with: text) == false {
                if let index = answeredItems.lastIndex(of: question.itemId) {
                    answeredItems.remove(at: index)
                }
                giveBack(question)
            }
        }
    }

    private func skip(_ question: Question) {
        guard !isAdvancing else { return }
        advance(skipping: true)
        Task {
            if await model.answer(question, with: nil) == false {
                giveBack(question)
            }
        }
    }

    /// Flies the top card away (up for an answer, left for a skip) with a bouncy spring, then
    /// lets the next 1 slide up into place.
    private func advance(skipping: Bool) {
        guard !deck.isEmpty, !isAdvancing else { return }
        isAdvancing = true
        tick += 1
        withAnimation(Motion.bouncy) {
            flyOut = skipping ? CGSize(width: -560, height: 40) : CGSize(width: 0, height: -760)
            flyTilt = skipping ? -14 : 0
        }
        Task {
            try? await Task.sleep(for: .milliseconds(240))
            withAnimation(Motion.bouncy) {
                if !deck.isEmpty { deck.removeFirst() }
                flyOut = .zero
                flyTilt = 0
                drag = .zero
            }
            isAdvancing = false
        }
    }

    /// A save failed: the card comes back, right behind the 1 on top.
    private func giveBack(_ question: Question) {
        guard !deck.contains(where: { $0.id == question.id }) else { return }
        withAnimation(Motion.bouncy) {
            deck.insert(question, at: min(1, deck.count))
        }
    }
}

// MARK: - Question card

private struct QuestionCard: View {
    var question: Question
    var item: ShelfItem?
    /// 0 to 1 as the card is dragged toward a skip.
    var skipHint: CGFloat
    var onAnswer: (String) -> Void
    var onPhoto: () -> Void

    var body: some View {
        PaperCard(padding: Space.lg) {
            VStack(alignment: .leading, spacing: Space.lg) {
                HStack(spacing: Space.sm) {
                    thumbnail
                        .frame(width: 56, height: 56)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item?.title ?? question.itemTitle)
                            .font(.system(size: 15, weight: .semibold, design: .rounded))
                            .foregroundStyle(Palette.ink)
                            .lineLimit(2)
                        if let item {
                            ReadinessMark(readiness: item.readiness, isWorking: item.isAppraising)
                                .scaleEffect(0.92, anchor: .leading)
                        }
                    }
                    Spacer(minLength: 0)
                }

                Text(question.prompt)
                    .font(Typo.title2)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)

                QuestionAnswerControls(question: question, onAnswer: onAnswer, onPhoto: onPhoto)
                    .id(question.id)
            }
        }
        .overlay(alignment: .topTrailing) {
            Text("Skip")
                .font(.system(size: 15, weight: .bold, design: .rounded))
                .foregroundStyle(Palette.inkSecondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .glassEffect(.regular, in: .capsule)
                .padding(Space.md)
                .opacity(skipHint)
                .allowsHitTesting(false)
        }
    }

    @ViewBuilder
    private var thumbnail: some View {
        if let item {
            ItemArtwork(item: item, cornerRadius: Radius.small, symbolScale: 0.42)
        } else if let url = question.thumbnailUrl.flatMap(URL.init(string:)) {
            RemoteImage(url: url)
                .background(Palette.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
                .fill(Palette.surfaceRaised)
        }
    }
}
