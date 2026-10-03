import Foundation

// Wire shapes for Circles (docs/contracts/m3-circles.md) and Deal Sheets
// (docs/contracts/m3-deals.md), and how they become the view models the screens use.

nonisolated struct APICircle: Decodable, Sendable {
    var id: String
    var name: String
    var categoryFocus: [String]
    var role: String
    var memberCount: Int
    var createdAt: String
}

nonisolated struct APICircleMember: Decodable, Sendable {
    var userId: String
    var firstName: String?
    var photoUrl: String?
    var role: String
    var joinedAt: String
}

nonisolated struct APICircleDetail: Decodable, Sendable {
    var id: String
    var name: String
    var categoryFocus: [String]
    var role: String
    var memberCount: Int
    var members: [APICircleMember]
}

nonisolated struct CirclesResponse: Decodable, Sendable {
    var circles: [APICircle]
}

nonisolated struct NewCircleRequest: Encodable, Sendable {
    var name: String
}

nonisolated struct EmptyBody: Encodable, Sendable {}

nonisolated struct APIInvite: Decodable, Sendable {
    var code: String
    var circleId: String
    var maxUses: Int
    var uses: Int
    var expiresAt: String
}

nonisolated struct InvitePreview: Decodable, Hashable, Sendable {
    enum Status: String, Decodable, Sendable {
        case open, expired, full
        case alreadyMember = "already_member"
    }

    var code: String
    var circleName: String
    var inviterFirstName: String?
    var memberCount: Int
    var status: Status
}

nonisolated struct APIDealPerson: Decodable, Sendable {
    var userId: String
    var firstName: String?
    var photoUrl: String?
}

nonisolated struct APIDealParticipant: Decodable, Sendable {
    var userId: String
    var firstName: String?
    var photoUrl: String?
    var approval: ApprovalState
}

nonisolated struct APIDealItem: Decodable, Sendable {
    var id: String
    var title: String
    var category: String?
    var brand: String?
    var model: String?
    var conditionGrade: ConditionGrade?
    var value: ValueRange?
    var photoUrl: String?
}

nonisolated struct APIDealSheet: Decodable, Sendable {
    nonisolated struct Cash: Decodable, Sendable {
        var payCents: Int
        var receiveCents: Int
    }
    nonisolated struct LoopLeg: Decodable, Sendable {
        var giver: APIDealPerson
        var receiver: APIDealPerson
        var item: APIDealItem
    }

    var id: String
    var status: DealPhase
    var expiresAt: String
    var youGive: APIDealItem
    var giveTo: APIDealPerson
    var youGet: APIDealItem
    var getFrom: APIDealPerson
    var cash: Cash
    var loop: [LoopLeg]
    var participants: [APIDealParticipant]
    var yourApproval: ApprovalState
    var why: String?
}

nonisolated struct DealSheetsResponse: Decodable, Sendable {
    var deals: [APIDealSheet]
}

nonisolated struct DeclineRequest: Encodable, Sendable {
    var reason: String?
}

nonisolated enum WireDate {
    /// The API sends toISOString() (with milliseconds); accept both forms.
    static func parse(_ raw: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(raw))
            ?? (try? Date.ISO8601FormatStyle().parse(raw))
    }
}

// MARK: Mapping

extension Person {
    /// Avatar tints follow the user ID, so the same person keeps their color everywhere.
    nonisolated static func live(id: String, firstName: String?, photoURL: String?) -> Person {
        Person(
            id: id,
            name: firstName ?? "Someone",
            // Not hashValue: it changes every launch.
            hue: id.unicodeScalars.reduce(0) { ($0 + Int($1.value)) % 997 } % 4,
            photoURL: photoURL.flatMap(URL.init(string:))
        )
    }
}

extension TradeCircle {
    nonisolated init(_ c: APICircle, members: [Person] = []) {
        self.init(
            id: c.id,
            name: c.name,
            focus: Self.focusLabel(c.categoryFocus),
            members: members,
            memberCount: c.memberCount,
            isOwner: c.role == "owner"
        )
    }

    nonisolated init(_ c: APICircleDetail) {
        self.init(
            id: c.id,
            name: c.name,
            focus: Self.focusLabel(c.categoryFocus),
            members: c.members.map { Person.live(id: $0.userId, firstName: $0.firstName, photoURL: $0.photoUrl) },
            memberCount: c.memberCount,
            isOwner: c.role == "owner"
        )
    }

    /// "toys/lego" reads as "Lego".
    private nonisolated static func focusLabel(_ paths: [String]) -> String? {
        let labels = paths.compactMap { $0.split(separator: "/").last.map { String($0).replacingOccurrences(of: "_", with: " ").capitalized } }
        return labels.isEmpty ? nil : labels.joined(separator: ", ")
    }
}

extension ShelfItem {
    /// Someone's Item as a Deal shows it. Every Item in a shown Deal is showcase and held.
    nonisolated init(dealItem i: APIDealItem) {
        self.init(
            id: i.id,
            status: .reserved,
            title: i.title,
            willingness: .wouldTrade,
            category: i.category,
            brand: i.brand,
            model: i.model,
            variant: nil,
            conditionGrade: i.conditionGrade,
            defects: [],
            value: i.value,
            identityConfidence: nil,
            conditionConfidence: nil,
            isReserved: true,
            thumbnailUrl: i.photoUrl
        )
        readiness = .showcase
    }
}

extension DealSheet {
    nonisolated init(_ d: APIDealSheet) {
        // The Loop in order, starting from the caller's receiver so it reads as a chain.
        let people = d.participants.map { Person.live(id: $0.userId, firstName: $0.firstName, photoURL: $0.photoUrl) }
        self.init(
            id: d.id,
            give: [ShelfItem(dealItem: d.youGive)],
            receive: [ShelfItem(dealItem: d.youGet)],
            throwInCents: d.cash.payCents - d.cash.receiveCents,
            participants: Self.loopOrder(d, people),
            why: d.why,
            expiresAt: WireDate.parse(d.expiresAt) ?? .now,
            status: d.status,
            myApproval: d.yourApproval
        )
    }

    /// Follows the legs giver to receiver, so the arrows between avatars mean "gives to".
    private nonisolated static func loopOrder(_ d: APIDealSheet, _ people: [Person]) -> [Person] {
        let byID = Dictionary(people.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let next = Dictionary(d.loop.map { ($0.giver.userId, $0.receiver.userId) }, uniquingKeysWith: { a, _ in a })
        guard let start = d.loop.first?.giver.userId else { return people }
        var ordered: [Person] = []
        var current = start
        while let person = byID[current], !ordered.contains(where: { $0.id == current }) {
            ordered.append(person)
            guard let following = next[current] else { break }
            current = following
        }
        return ordered.count == people.count ? ordered : people
    }
}
