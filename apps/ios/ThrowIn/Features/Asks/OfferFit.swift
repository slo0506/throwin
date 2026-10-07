import Foundation

/// Whether an Ask's offer can pay for what it's after, in the GM's words.
///
/// Each person has to come out within the matcher's tolerance: 15% of the larger side or $10,
/// whichever is more (docs/contracts/m3-matcher.md). Most Deals swap 1 Item each way plus
/// cash; the matcher adds more of the offer only when the other side wants several, which
/// nobody can count on. So what counts is the best single Item in the offer plus the cash
/// ceiling, never the sum of everything offered. Computed on device from mid values, so it
/// answers instantly as you tap.
nonisolated struct OfferFit: Equatable, Sendable {
    enum Verdict: Equatable, Sendable {
        /// What the Ask is after has no price yet.
        case pricing
        /// Nothing offered yet.
        case empty
        /// The best Item covers it on its own.
        case fits
        /// The best Item covers it with about this much cash, within the ceiling.
        case fitsWithCash(Int)
        /// Every offered Item is worth clearly more: the other side would pay cash back.
        case worthMore
        /// Even the best Item plus all the cash falls short by about this much.
        case short(Int)
    }

    var verdict: Verdict
    /// The offered Item the verdict is about.
    var best: ShelfItem?
    /// What the Ask usually goes for.
    var target: ValueRange?
    /// A Shelf Item that isn't offered yet and would do better than the current offer.
    var suggestion: ShelfItem?

    static let tolerancePct = 0.15
    static let toleranceFloorCents = 1000

    /// How far apart a give and a get can be and still balance, per the matcher.
    static func tolerance(_ a: Int, _ b: Int) -> Int {
        max(Int((Double(max(a, b)) * tolerancePct).rounded()), toleranceFloorCents)
    }

    /// How 1 Item does against the target on its own, with up to `ceilingCents` of cash.
    static func verdict(for item: ShelfItem, target: ValueRange, ceilingCents: Int) -> Verdict? {
        guard let value = item.value?.midCents else { return nil }
        let goal = target.midCents
        let tolerance = tolerance(goal, value)
        if value > goal + tolerance { return .worthMore }
        if value >= goal - tolerance { return .fits }
        let need = goal - tolerance - value
        if need <= ceilingCents { return .fitsWithCash(roundUp(need)) }
        return .short(roundUp(need - ceilingCents))
    }

    /// Lower is better: no cash, then a little cash, then cash back, then short.
    private static func rank(_ verdict: Verdict, item: ShelfItem, target: ValueRange) -> (Int, Int) {
        let distance = abs((item.value?.midCents ?? 0) - target.midCents)
        switch verdict {
        case .fits: return (0, distance)
        case let .fitsWithCash(cents): return (1, cents)
        case .worthMore: return (2, distance)
        case let .short(cents): return (3, cents)
        case .pricing, .empty: return (4, distance)
        }
    }

    /// The best of `items` against the target, or nil when none has a value.
    static func best(of items: [ShelfItem], target: ValueRange, ceilingCents: Int) -> (ShelfItem, Verdict)? {
        items
            .compactMap { item in verdict(for: item, target: target, ceilingCents: ceilingCents).map { (item, $0) } }
            .min { rank($0.1, item: $0.0, target: target) < rank($1.1, item: $1.0, target: target) }
    }

    /// `offered` are the Items in the offer; `shelf` is everything the GM could suggest from.
    init(target: ValueRange?, offered: [ShelfItem], shelf: [ShelfItem], ceilingCents: Int) {
        self.target = target
        guard let target else {
            verdict = .pricing
            return
        }
        let current = Self.best(of: offered, target: target, ceilingCents: ceilingCents)
        verdict = current?.1 ?? .empty
        best = current?.0

        // Suggest only what clearly helps: a fit when the offer falls short or is empty, or
        // an even swap when the current best needs cash or would get cash back.
        let offeredIDs = Set(offered.map(\.id))
        let spare = shelf.filter { item in
            !offeredIDs.contains(item.id)
                && item.status == .onShelf
                && !item.isReserved
                && item.willingness != .notAvailable
        }
        guard let candidate = Self.best(of: spare, target: target, ceilingCents: ceilingCents) else { return }
        let currentRank = current.map { Self.rank($0.1, item: $0.0, target: target).0 } ?? 4
        let candidateRank = Self.rank(candidate.1, item: candidate.0, target: target).0
        if candidateRank < currentRank, candidateRank <= 1 {
            suggestion = candidate.0
        }
    }

    // MARK: Words

    /// The GM's 1 or 2 sentences about the offer. Numbers are ranges or "about", never exact.
    var line: String {
        switch verdict {
        case .pricing:
            return "I'm still pricing this. Pick what you'd give up in the meantime."
        case .empty:
            return "Pick what you'd give up for it. I'll offer 1 of them, plus cash if it's uneven, or more if they want several."
        case .fits:
            return "Your \(bestName) covers it on its own."
        case let .fitsWithCash(cents):
            return "Your \(bestName) plus about \(Money.dollars(cents)) covers it."
        case .worthMore:
            return "Your \(bestName) is worth more than this, so you'd get cash back. Something closer in value is an easier yes."
        case let .short(cents):
            guard let target, let value = best?.value else { return "" }
            if reachesHalf {
                return "A bit short. Add about \(Money.dollars(cents)) more cash, or offer something closer to \(Money.range(low: target.lowCents, high: target.highCents))."
            }
            return "Unlikely as is. Your \(bestName) is worth about \(value.label), and this goes for \(target.label). I can only add more of your things if they want several."
        }
    }

    /// How the GM feels about it, for the tint and the symbol.
    var mood: Mood {
        switch verdict {
        case .fits, .fitsWithCash: .good
        case .worthMore: .okay
        case .short: reachesHalf ? .okay : .bad
        case .pricing, .empty: .neutral
        }
    }

    enum Mood: Sendable { case good, okay, bad, neutral }

    private var reachesHalf: Bool {
        guard let target, let value = best?.value else { return false }
        return Double(value.midCents) / Double(max(target.midCents, 1)) >= 0.6
    }

    private var bestName: String { best.map { Self.shortName($0.title) } ?? "offer" }

    /// Titles can be long ("Nintendo Switch OLED Model, White, 64GB"): the part before the
    /// first comma reads naturally in a sentence.
    static func shortName(_ title: String) -> String {
        let head = title.split(separator: ",").first.map(String.init) ?? title
        return head.trimmingCharacters(in: .whitespaces)
    }

    /// Up to the next $5: estimates shouldn't look precise.
    static func roundUp(_ cents: Int) -> Int {
        guard cents > 0 else { return 0 }
        return (cents + 499) / 500 * 500
    }
}
