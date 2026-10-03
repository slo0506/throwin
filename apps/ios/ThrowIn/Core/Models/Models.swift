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
    case draft, needsPhotos = "needs_photos", onShelf = "on_shelf", reserved, traded, removed
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
    /// A specific photo the Appraiser needs, e.g. "Photo of the size tag".
    var followUp: String?
    /// True while the Appraiser is still pricing or re-reading the Item. `value` may be nil then.
    var isAppraising: Bool = false

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
    }

    /// Hand-written so a missing `is_appraising` (older servers) decodes as false.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        status = try c.decode(ItemStatus.self, forKey: .status)
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
        followUp = try c.decodeIfPresent(String.self, forKey: .followUp)
        isAppraising = try c.decodeIfPresent(Bool.self, forKey: .isAppraising) ?? false
    }
}

nonisolated struct ShelfResponse: Codable, Sendable {
    var items: [ShelfItem]
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

// MARK: - Not yet on the API (Milestones 2 and 3). Used by demo mode.

nonisolated enum AskStatus: String, Codable, Sendable {
    case drafting, offering, prospecting, proposed, accepted, fulfilled, expired, cancelled
}

nonisolated struct Ask: Identifiable, Hashable, Sendable {
    var id: String
    var title: String
    var detail: String
    var status: AskStatus
    var cashCeilingCents: Int
    var anchor: ValueRange
    var offerItemIDs: [String]
    var shelvesChecked: Int
    var circlesChecked: Int
    var candidates: Int
}

nonisolated struct Person: Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var hue: Int          // index into the Loop palette, for avatar tint
    var rating: Double
    var circle: String

    var initials: String { String(name.prefix(1)) }
}

nonisolated struct DealSheet: Identifiable, Hashable, Sendable {
    var id: String
    var give: [ShelfItem]
    var receive: [ShelfItem]
    var throwInCents: Int          // positive: you pay; negative: you receive
    var participants: [Person]
    var why: String
    var expiresInHours: Int

    var giveValue: Int { give.compactMap(\.value?.midCents).reduce(0, +) }
    var getValue: Int { receive.compactMap(\.value?.midCents).reduce(0, +) }
    var isLoop: Bool { participants.count > 2 }
}

nonisolated struct TradeCircle: Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var focus: String
    var members: [Person]
    var defaultSpot: String
    var inviteURL: URL
}

nonisolated struct TasteFact: Identifiable, Hashable, Sendable {
    var id: String
    var text: String
    var source: String
}
