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

nonisolated struct APIDealPerson: Decodable, Hashable, Sendable {
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

nonisolated struct APIDealItem: Decodable, Hashable, Sendable {
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
    nonisolated struct Cash: Decodable, Hashable, Sendable {
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
    /// Every Item on each side; several is a bundle. Older servers send only `youGive` and `youGet`.
    var gives: [APIDealItem]?
    var gets: [APIDealItem]?
    /// An open counter. While it's open, nobody can approve. Older servers don't send it.
    var counter: APIDealCounter?
    var countersLeft: Int?
    /// Set when an accepted counter replaced this Deal.
    var supersededBy: String?
    var cash: Cash
    var loop: [LoopLeg]
    var participants: [APIDealParticipant]
    var yourApproval: ApprovalState
    var why: String?
    /// The caller's own Ask this Deal fills. Older servers don't send it.
    var yourAskId: String?
}

/// A counter on a Deal, from the caller's side (docs/contracts/m3-deals.md, "Counters").
nonisolated struct APIDealCounter: Decodable, Sendable {
    nonisolated struct Change: Decodable, Sendable {
        var op: String
        var item: APIDealItem
        var giver: APIDealPerson
        var receiver: APIDealPerson
    }

    var id: String
    var proposedBy: APIDealPerson
    var changes: [Change]
    var gives: [APIDealItem]
    var gets: [APIDealItem]
    var cash: APIDealSheet.Cash
    /// "pending", "accepted" or "declined"; nil when the counter doesn't ask the caller.
    var yourAnswer: String?
    var waitingOn: [APIDealPerson]
}

/// 1 change in a counter, as the API takes it.
nonisolated struct CounterChange: Codable, Hashable, Sendable {
    var op: String
    var itemId: String
}

nonisolated struct CounterRequest: Encodable, Sendable {
    var changes: [CounterChange]
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
            give: (d.gives ?? [d.youGive]).map { ShelfItem(dealItem: $0) },
            receive: (d.gets ?? [d.youGet]).map { ShelfItem(dealItem: $0) },
            throwInCents: d.cash.payCents - d.cash.receiveCents,
            participants: Self.loopOrder(d, people),
            why: d.why,
            expiresAt: WireDate.parse(d.expiresAt) ?? .now,
            status: d.status,
            myApproval: d.yourApproval,
            askID: d.yourAskId,
            waitingOn: d.participants.filter { $0.approval == .pending }.map { $0.firstName ?? "someone" },
            counter: d.counter.map { DealCounter($0, me: Self.caller(d)) },
            countersLeft: d.countersLeft ?? 3,
            supersededBy: d.supersededBy
        )
    }

    /// The caller is whoever is in the Deal but neither gives to them nor gets from them.
    private nonisolated static func caller(_ d: APIDealSheet) -> String? {
        let others: Set<String> = [d.giveTo.userId, d.getFrom.userId]
        return d.participants.first { !others.contains($0.userId) }?.userId
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

extension DealCounter {
    nonisolated init(_ c: APIDealCounter, me: String?) {
        let name = { (p: APIDealPerson) in p.firstName ?? "someone" }
        self.init(
            id: c.id,
            proposer: name(c.proposedBy),
            isMine: c.proposedBy.userId == me,
            changes: c.changes.map { change in
                DealCounter.Change(
                    isAdd: change.op == "add",
                    item: ShelfItem(dealItem: change.item),
                    giver: name(change.giver),
                    receiver: name(change.receiver),
                    fromMe: change.giver.userId == me,
                    toMe: change.receiver.userId == me
                )
            },
            give: c.gives.map { ShelfItem(dealItem: $0) },
            receive: c.gets.map { ShelfItem(dealItem: $0) },
            throwInCents: c.cash.payCents - c.cash.receiveCents,
            yourAnswer: c.yourAnswer.flatMap(DealCounter.Answer.init(rawValue:)),
            waitingOn: c.waitingOn.map(name)
        )
    }
}
