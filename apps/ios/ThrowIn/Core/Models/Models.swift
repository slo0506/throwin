import Foundation

// Wire models mirror `packages/shared/src/api.ts`. JSON keys are snake_case and decoded with
// `.convertFromSnakeCase`. Money is integer cents.

nonisolated struct ValueRange: Codable, Hashable, Sendable {
    var lowCents: Int
    var midCents: Int
    var highCents: Int
    var currency: String = "USD"

    var label: String { Money.range(low: lowCents, high: highCents) }
}

nonisolated enum ItemStatus: String, Codable, Sendable {
    /// `needs_photos` is retired by the server. Still decoded so older rows don't fail, but
    /// read as `onShelf` (see `ShelfItem.init(from:)`).
    case draft, needsPhotos = "needs_photos", onShelf = "on_shelf", reserved, traded, removed
}

/// What an Item still needs, in 1 word. See "Item readiness" in the PRD.
nonisolated enum ItemReadiness: String, Codable, CaseIterable, Sendable {
    case logged, identified, showcase

    var label: String {
        switch self {
        case .logged: "Logged"
        case .identified: "Identified"
        case .showcase: "Ready to show"
        }
    }

    /// How sure the GM is, in plain words. Never a number.
    var confidencePhrase: String {
        self == .logged ? "Best guess" : "Pretty sure"
    }

    var step: Int {
        switch self {
        case .logged: 0
        case .identified: 1
        case .showcase: 2
        }
    }
}

nonisolated enum Willingness: String, Codable, CaseIterable, Sendable {
    case wouldTrade = "would_trade"
    case openToOffers = "open_to_offers"
    case notAvailable = "not_available"

    var label: String {
        switch self {
        case .wouldTrade: "Would trade"
        case .openToOffers: "Open to offers"
        case .notAvailable: "Not available"
        }
    }
}

nonisolated enum ConditionGrade: String, Codable, CaseIterable, Sendable {
    case a = "A", b = "B", c = "C", d = "D"

    var meaning: String {
        switch self {
        case .a: "Like new"
        case .b: "Lightly used"
        case .c: "Used"
        case .d: "Well loved"
        }
    }
}

nonisolated enum AutonomyLevel: String, Codable, CaseIterable, Sendable {
    case everyDeal = "every_deal"
    case likelyYes = "likely_yes"

    var title: String {
        switch self {
        case .everyDeal: "Bring me every deal"
        case .likelyYes: "Only likely yeses"
        }
    }

    var detail: String {
        switch self {
        case .everyDeal: "You see everything your GM finds."
        case .likelyYes: "Your GM filters out deals it thinks you'd pass on."
        }
    }
}

nonisolated struct ShelfItem: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var status: ItemStatus
    var title: String
    var willingness: Willingness
    var category: String?
    var brand: String?
    var model: String?
    var variant: String?
    var conditionGrade: ConditionGrade?
    var defects: [String]
    var value: ValueRange?
    var identityConfidence: Double?
    var conditionConfidence: Double?
    var isReserved: Bool
    var thumbnailUrl: String?
    /// Every photo, the best first, for the product page carousel. Empty from older servers.
    var photoUrls: [String] = []
    /// A specific photo the Appraiser needs, e.g. "Photo of the size tag".
    var followUp: String?
    /// True while the Appraiser is still pricing or re-reading the Item. `value` may be nil then.
    var isAppraising: Bool = false
    var readiness: ItemReadiness = .logged
    /// 0 to 100. Only ever compared against thresholds, never shown.
    var photoScore: Int?
    /// Codes: too_small, blurry, dark, cut_off, cluttered_background, missing_angles.
    var photoIssues: [String] = []
    /// Human labels for the showcase angles still missing, like "Both soles".
    var missingAngles: [String] = []
    /// The photo is good enough (score 50 or more) to lift into Studio.
    var studioAllowed: Bool = false
    /// 2 to 3 plain sentences from the GM.
    var itemDescription: String?
    var openQuestions: Int = 0

    /// Below the inventory floor: the card gets the tangerine "Inventory photo" tag.
    var hasInventoryPhoto: Bool { (photoScore ?? 100) < 50 }

    /// The angles the Showcase shoot walks through, capped at what 1 upload takes.
    var showcaseAngles: [String] {
        let angles = missingAngles.isEmpty ? ["Front", "Back"] : missingAngles
        return Array(angles.prefix(5))
    }

    /// Still being priced: show the Pricing placeholder instead of a range.
    var isPricing: Bool { isAppraising && value == nil }

    /// Plain-language confidence. We never show raw scores.
    var confidenceLabel: String {
        let score = min(identityConfidence ?? 0, conditionConfidence ?? 1)
        switch score {
        case 0.85...: return "Confident"
        case 0.7..<0.85: return "Pretty sure"
        default: return "Needs 1 more photo"
        }
    }
}

nonisolated extension ShelfItem {
    enum CodingKeys: String, CodingKey {
        case id, status, title, willingness, category, brand, model, variant, conditionGrade, defects, value
        case identityConfidence, conditionConfidence, isReserved, thumbnailUrl, followUp, isAppraising
        case readiness, photoScore, photoIssues, missingAngles, studioAllowed, openQuestions, photoUrls
        case itemDescription = "description"
    }

    /// Hand-written so fields older servers don't send (`is_appraising`, readiness and the
    /// photo fields) decode with safe defaults.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        let decodedStatus = try c.decode(ItemStatus.self, forKey: .status)
        status = decodedStatus == .needsPhotos ? .onShelf : decodedStatus
        title = try c.decode(String.self, forKey: .title)
        willingness = try c.decode(Willingness.self, forKey: .willingness)
        category = try c.decodeIfPresent(String.self, forKey: .category)
        brand = try c.decodeIfPresent(String.self, forKey: .brand)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        variant = try c.decodeIfPresent(String.self, forKey: .variant)
        conditionGrade = try c.decodeIfPresent(ConditionGrade.self, forKey: .conditionGrade)
        defects = try c.decode([String].self, forKey: .defects)
        value = try c.decodeIfPresent(ValueRange.self, forKey: .value)
        identityConfidence = try c.decodeIfPresent(Double.self, forKey: .identityConfidence)
        conditionConfidence = try c.decodeIfPresent(Double.self, forKey: .conditionConfidence)
        isReserved = try c.decode(Bool.self, forKey: .isReserved)
        thumbnailUrl = try c.decodeIfPresent(String.self, forKey: .thumbnailUrl)
        photoUrls = (try? c.decodeIfPresent([String].self, forKey: .photoUrls)) ?? []
        followUp = try c.decodeIfPresent(String.self, forKey: .followUp)
        isAppraising = try c.decodeIfPresent(Bool.self, forKey: .isAppraising) ?? false
        readiness = (try? c.decodeIfPresent(ItemReadiness.self, forKey: .readiness)) ?? .logged
        photoScore = try? c.decodeIfPresent(Int.self, forKey: .photoScore)
        photoIssues = (try? c.decodeIfPresent([String].self, forKey: .photoIssues)) ?? []
        missingAngles = (try? c.decodeIfPresent([String].self, forKey: .missingAngles)) ?? []
        studioAllowed = (try? c.decodeIfPresent(Bool.self, forKey: .studioAllowed)) ?? false
        itemDescription = try? c.decodeIfPresent(String.self, forKey: .itemDescription)
        openQuestions = (try? c.decodeIfPresent(Int.self, forKey: .openQuestions)) ?? 0
    }
}

nonisolated struct ShelfResponse: Codable, Sendable {
    var items: [ShelfItem]
}

// MARK: - Refinement

nonisolated enum QuestionKind: String, Codable, Sendable {
    case yesNo = "yes_no", choice, picker, text, photo
}

/// 1 Tune up question from the Refiner: the cheapest useful thing to ask about an Item.
nonisolated struct Question: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var itemId: String
    var itemTitle: String
    var thumbnailUrl: String?
    var kind: QuestionKind
    var prompt: String
    var options: [String]
    var createdAt: String?

    /// The angle a photo question asks for, as the Showcase shoot labels it.
    var photoAngle: String { options.first ?? prompt }
}

nonisolated extension Question {
    enum CodingKeys: String, CodingKey {
        case id, itemId, itemTitle, thumbnailUrl, kind, prompt, options, createdAt
    }

    /// An unknown kind reads as a short text answer, so a newer server never breaks Tune up.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        itemId = try c.decode(String.self, forKey: .itemId)
        itemTitle = (try? c.decodeIfPresent(String.self, forKey: .itemTitle)) ?? ""
        thumbnailUrl = try? c.decodeIfPresent(String.self, forKey: .thumbnailUrl)
        let rawKind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? ""
        kind = QuestionKind(rawValue: rawKind) ?? .text
        prompt = try c.decode(String.self, forKey: .prompt)
        options = (try? c.decodeIfPresent([String].self, forKey: .options)) ?? []
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

nonisolated struct QuestionsResponse: Decodable, Sendable {
    var questions: [Question]
}

/// `POST /v1/questions/:id/answer`: `{ "answer": "Yes" }` or `{ "skip": true }`.
nonisolated struct AnswerRequest: Encodable, Sendable {
    var answer: String?
    var skip: Bool?
}

nonisolated struct AnswerResponse: Decodable, Sendable {
    var item: ShelfItem
}

nonisolated struct ItemPatch: Encodable, Sendable {
    var title: String?
    var willingness: Willingness?
    var conditionGrade: ConditionGrade?
    /// The user confirmed the GM's read. Moves needs_photos to on_shelf.
    var confirm: Bool?
}

// MARK: - Capture

nonisolated enum CaptureStatus: String, Codable, Sendable {
    case uploading, processing, done, failed
}

nonisolated struct UploadRequest: Encodable, Sendable {
    var count: Int
    var kind: String = "photo"
}

nonisolated struct UploadSlot: Decodable, Sendable {
    var path: String
    var uploadUrl: URL
}

nonisolated struct UploadResponse: Decodable, Sendable {
    var captureId: String
    var uploads: [UploadSlot]
}

nonisolated struct CaptureMediaInput: Encodable, Sendable {
    var path: String
    var width: Int?
    var height: Int?
    var sharpness: Double?
}

/// `POST /v1/items/:id/media/uploads`: 1 to 5 more photos for an Item.
nonisolated struct ItemUploadRequest: Encodable, Sendable {
    var count: Int
}

nonisolated struct ItemUploadResponse: Decodable, Sendable {
    var uploads: [UploadSlot]
}

/// `POST /v1/items/:id/media`: the uploaded photos, so the Appraiser takes another look.
nonisolated struct ItemMediaRequest: Encodable, Sendable {
    var media: [CaptureMediaInput]
}

nonisolated struct CaptureRequest: Encodable, Sendable {
    var captureId: String
    var media: [CaptureMediaInput]
}

nonisolated struct CaptureProgress: Codable, Hashable, Sendable {
    var stage: String?
    var detail: String?
    var found: Int?
}

nonisolated struct Capture: Decodable, Sendable {
    var id: String
    var status: CaptureStatus
    var mediaCount: Int
    var itemCount: Int
    var progress: CaptureProgress
    var error: String?
    var items: [ShelfItem]
}

nonisolated struct NotificationPrefs: Codable, Hashable, Sendable {
    var dealReady = true
    var itemWanted = true
    var approvalNudge = true
    var handoffReminder = true
    var askUpdate = true
    var promotional = false
}

nonisolated struct Profile: Codable, Hashable, Sendable {
    var autonomyLevel: AutonomyLevel
    var notificationPrefs: NotificationPrefs
    var homeArea: String?
    var defaultHandoffPlaceId: String?
}

nonisolated struct MeCounts: Codable, Hashable, Sendable {
    var shelfItems: Int
    var activeAsks: Int
    var circles: Int
}

nonisolated struct Me: Codable, Hashable, Sendable {
    var id: String
    var displayName: String?
    var photoUrl: String?
    var profile: Profile
    var counts: MeCounts
}

nonisolated struct PatchMe: Encodable, Sendable {
    var displayName: String?
    var autonomyLevel: AutonomyLevel?
    var notificationPrefs: NotificationPrefs?
}

// MARK: - Not yet on the API (Milestone 3). Used by demo mode.

nonisolated struct Person: Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var hue: Int          // index into the Loop palette, for avatar tint
    /// Ratings arrive with handoffs (Milestone 4). Nil until then for live people.
    var rating: Double? = nil
    /// The Circle to show under their name, when there is one to show.
    var circle: String? = nil
    var photoURL: URL? = nil

    var initials: String { String(name.prefix(1)) }
}

/// Where a Deal is. Mirrors the server's deal_status; the app shows only these.
nonisolated enum DealPhase: String, Codable, Hashable, Sendable {
    case pendingApprovals = "pending_approvals"
    case approved
    case scheduling
    case inHandoff = "in_handoff"
    case completed
    case failed
    case cancelled
    case staged

    /// Still waiting on someone's answer.
    var isOpen: Bool { self == .pendingApprovals }
}

nonisolated enum ApprovalState: String, Codable, Hashable, Sendable {
    case pending, approved, declined
}

nonisolated struct DealSheet: Identifiable, Hashable, Sendable {
    var id: String
    var give: [ShelfItem]
    var receive: [ShelfItem]
    var throwInCents: Int          // positive: you pay; negative: you receive
    /// In Loop order, the caller included.
    var participants: [Person]
    /// Null until the Prospector's review writes it.
    var why: String?
    var expiresAt: Date
    var status: DealPhase = .pendingApprovals
    var myApproval: ApprovalState = .pending
    /// The caller's own Ask this Deal fills, when the server says.
    var askID: String?
    /// First names of the people who haven't approved yet.
    var waitingOn: [String] = []
    /// An open counter. While it's open, nobody can approve.
    var counter: DealCounter?
    /// How many more counters this Deal can have.
    var countersLeft: Int = 3
    /// Set when an accepted counter replaced this Deal and the new version isn't out yet.
    var supersededBy: String?

    /// What you get, by name: "Galaxy Explorer", or "Zelda and 1 more" for a bundle.
    var getTitle: String? {
        guard let first = receive.first else { return nil }
        return receive.count > 1 ? "\(first.title) and \(receive.count - 1) more" : first.title
    }

    var giveValue: Int { give.compactMap(\.value?.midCents).reduce(0, +) }
    var getValue: Int { receive.compactMap(\.value?.midCents).reduce(0, +) }
    var isLoop: Bool { participants.count > 2 }
    var expiresInHours: Int { max(0, Int(expiresAt.timeIntervalSinceNow / 3600)) }
}

/// Someone asked to change a Deal's Items, from your side: what changes, what you'd give,
/// get and pay, and whose answer it waits on.
nonisolated struct DealCounter: Identifiable, Hashable, Sendable {
    enum Answer: String, Hashable, Sendable { case pending, accepted, declined }

    struct Change: Identifiable, Hashable, Sendable {
        var id: String { "\(isAdd ? "add" : "remove"):\(item.id)" }
        var isAdd: Bool
        var item: ShelfItem
        var giver: String
        var receiver: String
        var fromMe: Bool
        var toMe: Bool

        /// "You add your Kirby", "Maya adds her Nike windbreaker", "You keep your Kirby".
        var line: String {
            let title = item.title
            switch (isAdd, fromMe, toMe) {
            case (true, true, _): return "You add your \(title)"
            case (true, _, true): return "\(giver) adds their \(title)"
            case (true, _, _): return "\(giver) adds \(title) for \(receiver)"
            case (false, true, _): return "You keep your \(title)"
            case (false, _, true): return "\(giver) keeps their \(title)"
            case (false, _, _): return "\(giver) keeps \(title)"
            }
        }
    }

    var id: String
    var proposer: String
    /// You proposed it.
    var isMine: Bool
    var changes: [Change]
    var give: [ShelfItem]
    var receive: [ShelfItem]
    /// Positive: you'd pay; negative: you'd receive.
    var throwInCents: Int
    /// Nil when the counter doesn't ask you.
    var yourAnswer: Answer?
    var waitingOn: [String]
}

nonisolated struct TradeCircle: Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    /// What the Circle is mostly into, like "LEGO". Nil when it has no focus set.
    var focus: String?
    var members: [Person]
    var memberCount: Int
    var isOwner: Bool = false
    /// The Circle's usual handoff spot. Not set up for live Circles yet.
    var defaultSpot: String?
    /// Demo Circles carry a fixed link; live ones make a fresh invite on demand.
    var inviteURL: URL?
}
