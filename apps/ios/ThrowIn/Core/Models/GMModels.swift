import Foundation

// Milestone 2 wire models. Source of truth: docs/contracts/m2-gm-and-asks.md.
// JSON is snake_case, decoded with `.convertFromSnakeCase`. Money is integer cents.
// Decoders are lenient: a field a newer server adds or drops never breaks a screen.

// MARK: - Ask

nonisolated enum AskStatus: String, Codable, Sendable {
    case drafting, offering, prospecting, proposed, accepted, fulfilled, expired, cancelled

    /// Plain words for when the server hasn't sent a `status_line`.
    var fallbackLine: String {
        switch self {
        case .drafting: "Getting the details right"
        case .offering: "Waiting for what you'd offer"
        case .prospecting: "Checking your Circles"
        case .proposed: "A deal is waiting on you"
        case .accepted: "Waiting on the others"
        case .fulfilled: "Done. It's yours."
        case .expired: "This Ask ran out of time"
        case .cancelled: "Cancelled"
        }
    }

    /// The GM is out looking right now.
    var isLooking: Bool { self == .prospecting || self == .accepted }
}

/// Retail and typical used price for what the Ask is after.
nonisolated struct AskAnchor: Codable, Hashable, Sendable {
    var retailCents: Int?
    var usedLowCents: Int?
    var usedHighCents: Int?
}

nonisolated struct AskTarget: Codable, Hashable, Sendable {
    /// `exact` or `category`.
    var kind: String
    var name: String?
    var brand: String?
    var model: String?
    var category: String?
    var constraints: [String] = []
    var anchor: AskAnchor?
}

nonisolated extension AskTarget {
    enum CodingKeys: String, CodingKey {
        case kind, name, brand, model, category, constraints, anchor
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "exact"
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        brand = try? c.decodeIfPresent(String.self, forKey: .brand)
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        category = try? c.decodeIfPresent(String.self, forKey: .category)
        constraints = (try? c.decodeIfPresent([String].self, forKey: .constraints)) ?? []
        anchor = try? c.decodeIfPresent(AskAnchor.self, forKey: .anchor)
    }
}

/// A low and high estimate with no midpoint, as the server sends an offer set's value.
nonisolated struct CentsRange: Codable, Hashable, Sendable {
    var lowCents: Int
    var highCents: Int
}

nonisolated struct Ask: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var rawText: String
    var title: String?
    var status: AskStatus
    /// Plain words from the server, like "Checking 46 Shelves in 2 Circles".
    var statusLine: String?
    var target: AskTarget?
    var offerItemIds: [String]
    var offerValue: CentsRange?
    /// Only ever returned to the Ask's owner.
    var cashCeilingCents: Int
    var autonomy: AutonomyLevel
    var deadline: String?
    var createdAt: String?
    var updatedAt: String?

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        if let name = target?.name, !name.isEmpty { return name }
        return rawText
    }

    var displayStatusLine: String {
        if let statusLine, !statusLine.isEmpty { return statusLine }
        return status.fallbackLine
    }

    /// The typical used price as a range, when the GM found 1.
    var usedRange: ValueRange? {
        guard let low = target?.anchor?.usedLowCents, let high = target?.anchor?.usedHighCents, high >= low else { return nil }
        return ValueRange(lowCents: low, midCents: (low + high) / 2, highCents: high)
    }

    var retailCents: Int? { target?.anchor?.retailCents }

    /// Still open: the GM can work on it and the user can change it.
    var isOpen: Bool {
        switch status {
        case .drafting, .offering, .prospecting, .proposed: true
        case .accepted, .fulfilled, .expired, .cancelled: false
        }
    }
}

nonisolated extension Ask {
    enum CodingKeys: String, CodingKey {
        case id, rawText, title, status, statusLine, target, offerItemIds, offerValue
        case cashCeilingCents, autonomy, deadline, createdAt, updatedAt
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        rawText = (try? c.decodeIfPresent(String.self, forKey: .rawText)) ?? ""
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        status = (try? c.decodeIfPresent(AskStatus.self, forKey: .status)) ?? .drafting
        statusLine = try? c.decodeIfPresent(String.self, forKey: .statusLine)
        target = try? c.decodeIfPresent(AskTarget.self, forKey: .target)
        offerItemIds = (try? c.decodeIfPresent([String].self, forKey: .offerItemIds)) ?? []
        offerValue = try? c.decodeIfPresent(CentsRange.self, forKey: .offerValue)
        cashCeilingCents = (try? c.decodeIfPresent(Int.self, forKey: .cashCeilingCents)) ?? 0
        autonomy = (try? c.decodeIfPresent(AutonomyLevel.self, forKey: .autonomy)) ?? .everyDeal
        deadline = try? c.decodeIfPresent(String.self, forKey: .deadline)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try? c.decodeIfPresent(String.self, forKey: .updatedAt)
    }
}

nonisolated struct AsksResponse: Decodable, Sendable {
    var asks: [Ask]
}

/// `POST /v1/asks`.
nonisolated struct NewAskRequest: Encodable, Sendable {
    var rawText: String
    var target: AskTarget?
    var cashCeilingCents: Int?
    var autonomy: AutonomyLevel?
}

/// `PATCH /v1/asks/{id}`. Only the fields that are set are sent.
nonisolated struct AskPatch: Encodable, Sendable {
    var rawText: String?
    var target: AskTarget?
    var offerItemIds: [String]?
    var cashCeilingCents: Int?
    var autonomy: AutonomyLevel?
    var deadline: String?
    var status: AskStatus?

    /// Writes the patched fields onto an Ask, for the optimistic update.
    func apply(to ask: inout Ask) {
        if let rawText { ask.rawText = rawText }
        if let target { ask.target = target }
        if let offerItemIds { ask.offerItemIds = offerItemIds }
        if let cashCeilingCents { ask.cashCeilingCents = cashCeilingCents }
        if let autonomy { ask.autonomy = autonomy }
        if let deadline { ask.deadline = deadline }
        if let status { ask.status = status }
    }

    /// Puts the patched fields back the way they were, leaving any other change alone.
    func revert(_ ask: inout Ask, to previous: Ask) {
        if rawText != nil { ask.rawText = previous.rawText }
        if target != nil { ask.target = previous.target }
        if offerItemIds != nil {
            ask.offerItemIds = previous.offerItemIds
            ask.offerValue = previous.offerValue
        }
        if cashCeilingCents != nil { ask.cashCeilingCents = previous.cashCeilingCents }
        if autonomy != nil { ask.autonomy = previous.autonomy }
        if deadline != nil { ask.deadline = previous.deadline }
        if status != nil {
            ask.status = previous.status
            ask.statusLine = previous.statusLine
        }
    }
}

// MARK: - Taste facts

nonisolated enum TasteCategory: String, CaseIterable, Sendable {
    case interests, hunting, limits, preferences, style, other

    var label: String {
        switch self {
        case .interests: "What you're into"
        case .hunting: "What you're hunting for"
        case .limits: "Never trade"
        case .preferences: "How you like to trade"
        case .style: "Your style"
        case .other: "Other things"
        }
    }
}

/// 1 thing the GM remembers about you. You can see and delete every 1 of them.
nonisolated struct TasteFact: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var key: String
    var value: String
    var category: String
    var source: String?
    var alwaysOn: Bool = false
    var createdAt: String?

    var group: TasteCategory { TasteCategory(rawValue: category) ?? .other }

    /// "never_trade" reads as "Never trade".
    var keyLabel: String {
        let words = key.replacingOccurrences(of: "_", with: " ").trimmingCharacters(in: .whitespaces)
        guard let first = words.first else { return "" }
        return first.uppercased() + words.dropFirst()
    }
}

nonisolated extension TasteFact {
    enum CodingKeys: String, CodingKey {
        case id, key, value, category, source, alwaysOn, createdAt
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        key = (try? c.decodeIfPresent(String.self, forKey: .key)) ?? ""
        value = (try? c.decodeIfPresent(String.self, forKey: .value)) ?? ""
        category = (try? c.decodeIfPresent(String.self, forKey: .category)) ?? "other"
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        alwaysOn = (try? c.decodeIfPresent(Bool.self, forKey: .alwaysOn)) ?? false
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

nonisolated struct TasteFactsResponse: Decodable, Sendable {
    var facts: [TasteFact]
}

// MARK: - GM conversation

nonisolated enum GMMode: String, Codable, Sendable {
    case intake, chat
}

nonisolated enum GMRole: String, Codable, Sendable {
    case user, assistant
}

/// What a selectable `item_cards` or a `choices` component posts back.
nonisolated struct GMChoice: Codable, Hashable, Sendable {
    var componentId: String
    var optionIds: [String]
}

/// `POST /v1/gm/messages`. At least 1 of text, choice or media.
nonisolated struct GMSendRequest: Encodable, Hashable, Sendable {
    var text: String?
    var choice: GMChoice?
    var mediaPaths: [String]?
    /// Where the user opened the GM from, like `new_ask`.
    var screen: String?
}

nonisolated struct GMSendResponse: Decodable, Sendable {
    var streamId: String
    var messageId: String
}

nonisolated struct GMHistoryMessage: Decodable, Identifiable, Sendable {
    var id: String
    var role: GMRole
    var text: String
    var components: [GMComponent]
    var createdAt: String?
}

nonisolated extension GMHistoryMessage {
    enum CodingKeys: String, CodingKey {
        case id, role, text, components, createdAt
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        role = (try? c.decodeIfPresent(GMRole.self, forKey: .role)) ?? .assistant
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        let lossy = (try? c.decodeIfPresent([Lossy<GMComponent>].self, forKey: .components)) ?? []
        components = lossy.compactMap(\.value)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

nonisolated struct GMConversation: Decodable, Sendable {
    var conversationId: String
    var mode: GMMode
    var messages: [GMHistoryMessage]
}

nonisolated extension GMConversation {
    enum CodingKeys: String, CodingKey {
        case conversationId, mode, messages
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = (try? c.decodeIfPresent(String.self, forKey: .conversationId)) ?? ""
        mode = (try? c.decodeIfPresent(GMMode.self, forKey: .mode)) ?? .chat
        let lossy = (try? c.decodeIfPresent([Lossy<GMHistoryMessage>].self, forKey: .messages)) ?? []
        messages = lossy.compactMap(\.value)
    }
}

/// Decodes 1 element of an array, or nil if it doesn't fit, so 1 bad row never sinks the rest.
nonisolated struct Lossy<Value: Decodable & Sendable>: Decodable, Sendable {
    var value: Value?

    init(from decoder: any Decoder) throws {
        value = try? Value(from: decoder)
    }
}

// MARK: - Components

/// An Item inside a GM card. Own Items arrive as full ShelfItems. Network Items arrive as a
/// smaller shape with the owner's first name.
nonisolated struct GMItem: Decodable, Identifiable, Hashable, Sendable {
    var item: ShelfItem
    var ownerFirstName: String?

    var id: String { item.id }

    init(item: ShelfItem, ownerFirstName: String? = nil) {
        self.item = item
        self.ownerFirstName = ownerFirstName
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, category, conditionGrade, value, thumbnailUrl, ownerFirstName, readiness
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ownerFirstName = try? c.decodeIfPresent(String.self, forKey: .ownerFirstName)
        if let full = try? ShelfItem(from: decoder) {
            item = full
            return
        }
        var item = ShelfItem(
            id: try c.decode(String.self, forKey: .id),
            status: .onShelf,
            title: (try? c.decodeIfPresent(String.self, forKey: .title)) ?? "An item",
            willingness: .wouldTrade,
            category: try? c.decodeIfPresent(String.self, forKey: .category),
            conditionGrade: try? c.decodeIfPresent(ConditionGrade.self, forKey: .conditionGrade),
            defects: [],
            value: try? c.decodeIfPresent(ValueRange.self, forKey: .value),
            isReserved: false,
            thumbnailUrl: try? c.decodeIfPresent(String.self, forKey: .thumbnailUrl)
        )
        item.readiness = (try? c.decodeIfPresent(ItemReadiness.self, forKey: .readiness)) ?? .showcase
        self.item = item
    }
}

nonisolated struct ItemCardsData: Decodable, Hashable, Sendable {
    var items: [GMItem]
    var selectable: Bool
    var selectedIds: [String]
}

nonisolated extension ItemCardsData {
    enum CodingKeys: String, CodingKey {
        case items, selectable, selectedIds
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let lossy = (try? c.decodeIfPresent([Lossy<GMItem>].self, forKey: .items)) ?? []
        items = lossy.compactMap(\.value)
        selectable = (try? c.decodeIfPresent(Bool.self, forKey: .selectable)) ?? false
        selectedIds = (try? c.decodeIfPresent([String].self, forKey: .selectedIds)) ?? []
    }
}

nonisolated struct ChoiceOption: Decodable, Identifiable, Hashable, Sendable {
    var id: String
    var label: String
    var detail: String?
}

nonisolated struct ChoicesData: Decodable, Hashable, Sendable {
    var prompt: String
    var options: [ChoiceOption]
    var multiple: Bool
}

nonisolated extension ChoicesData {
    enum CodingKeys: String, CodingKey {
        case prompt, options, multiple
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        prompt = (try? c.decodeIfPresent(String.self, forKey: .prompt)) ?? ""
        let lossy = (try? c.decodeIfPresent([Lossy<ChoiceOption>].self, forKey: .options)) ?? []
        options = lossy.compactMap(\.value)
        multiple = (try? c.decodeIfPresent(Bool.self, forKey: .multiple)) ?? false
    }
}

nonisolated struct CameraRequestData: Decodable, Hashable, Sendable {
    var instruction: String
    var itemId: String?
}

nonisolated struct SampleDecision: Decodable, Hashable, Sendable {
    var give: String
    var get: String
    /// `yes` or `no`.
    var verdict: String
    var why: String

    var isYes: Bool { verdict.lowercased() == "yes" }
}

nonisolated extension SampleDecision {
    enum CodingKeys: String, CodingKey {
        case give, get, verdict, why
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        give = (try? c.decodeIfPresent(String.self, forKey: .give)) ?? ""
        get = (try? c.decodeIfPresent(String.self, forKey: .get)) ?? ""
        verdict = (try? c.decodeIfPresent(String.self, forKey: .verdict)) ?? "no"
        why = (try? c.decodeIfPresent(String.self, forKey: .why)) ?? ""
    }
}

nonisolated struct RecapData: Decodable, Hashable, Sendable {
    var paragraph: String
    var sampleDecisions: [SampleDecision]

    /// Option IDs the recap's 2 chips post back as a `choice`.
    static let looksRight = "looks_right"
    static let fixSomething = "fix_something"
}

nonisolated extension RecapData {
    enum CodingKeys: String, CodingKey {
        case paragraph, sampleDecisions
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        paragraph = (try? c.decodeIfPresent(String.self, forKey: .paragraph)) ?? ""
        let lossy = (try? c.decodeIfPresent([Lossy<SampleDecision>].self, forKey: .sampleDecisions)) ?? []
        sampleDecisions = lossy.compactMap(\.value)
    }
}

/// A UI card the GM renders inline. Rebuilt from stored tool calls in history, so old cards
/// render the same.
nonisolated struct GMComponent: Decodable, Identifiable, Hashable, Sendable {
    enum Body: Hashable, Sendable {
        case itemCards(ItemCardsData)
        case choices(ChoicesData)
        case cameraRequest(CameraRequestData)
        case askCard(Ask)
        case recap(RecapData)
        /// A kind this build doesn't know yet. Not rendered.
        case unknown(String)
    }

    var id: String
    var body: Body

    init(id: String, body: Body) {
        self.id = id
        self.body = body
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, data
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        let kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? ""
        switch kind {
        case "item_cards":
            body = (try? c.decode(ItemCardsData.self, forKey: .data)).map(Body.itemCards) ?? .unknown(kind)
        case "choices":
            body = (try? c.decode(ChoicesData.self, forKey: .data)).map(Body.choices) ?? .unknown(kind)
        case "camera_request":
            body = (try? c.decode(CameraRequestData.self, forKey: .data)).map(Body.cameraRequest) ?? .unknown(kind)
        case "ask_card":
            body = (try? c.decode(Ask.self, forKey: .data)).map(Body.askCard) ?? .unknown(kind)
        case "recap":
            body = (try? c.decode(RecapData.self, forKey: .data)).map(Body.recap) ?? .unknown(kind)
        default:
            body = .unknown(kind)
        }
    }

    /// Cards that change the Asks or the Shelf, so the app refreshes them.
    var touchesContent: Bool {
        switch body {
        case .askCard, .itemCards: true
        default: false
        }
    }

    /// Cards the user answers. They lock once answered.
    var isAnswerable: Bool {
        switch body {
        case let .itemCards(data): data.selectable
        case .choices, .recap: true
        default: false
        }
    }

    var isKnown: Bool {
        if case .unknown = body { return false }
        return true
    }
}

// MARK: - Stream events

nonisolated struct GMTextDelta: Decodable, Sendable {
    var delta: String
}

nonisolated struct GMProgress: Decodable, Sendable {
    var label: String
}

nonisolated struct GMDone: Decodable, Sendable {
    var messageId: String?
}

nonisolated struct GMStreamError: Decodable, Sendable {
    var code: String?
    var message: String?
}

/// 1 event from `GET /v1/gm/stream/{id}`.
nonisolated enum GMEvent: Sendable {
    case text(String)
    case progress(String)
    case component(GMComponent)
    case done(messageID: String?)
    case error(code: String, message: String)
}
