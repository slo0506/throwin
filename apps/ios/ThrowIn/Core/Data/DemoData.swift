import Foundation

/// Sample content for demo mode, written to feel like a real Circle a week into the pilot.
enum DemoData {
    static func item(
        _ id: String,
        _ title: String,
        brand: String,
        category: String,
        grade: ConditionGrade,
        low: Int,
        mid: Int,
        high: Int,
        identity: Double = 0.9,
        condition: Double = 0.8,
        willingness: Willingness = .wouldTrade
    ) -> ShelfItem {
        ShelfItem(
            id: id,
            status: .onShelf,
            title: title,
            willingness: willingness,
            category: category,
            brand: brand,
            model: nil,
            variant: nil,
            conditionGrade: grade,
            defects: [],
            value: ValueRange(lowCents: low, midCents: mid, highCents: high),
            identityConfidence: identity,
            conditionConfidence: condition,
            isReserved: false,
            thumbnailUrl: nil
        )
    }

    static let shelf: [ShelfItem] = [
        item("i1", "Zelda: Tears of the Kingdom", brand: "Nintendo", category: "video_games", grade: .a, low: 3500, mid: 4200, high: 5000, identity: 0.97, condition: 0.9),
        item("i2", "Mario Kart 8 Deluxe", brand: "Nintendo", category: "video_games", grade: .b, low: 2400, mid: 2800, high: 3300, identity: 0.95, condition: 0.82),
        item("i3", "LEGO Typewriter 21327", brand: "LEGO", category: "toys/lego", grade: .b, low: 14000, mid: 16500, high: 19000, identity: 0.88, condition: 0.66),
        item("i4", "Air Jordan 1 Mid, size 10", brand: "Nike", category: "sneakers", grade: .c, low: 6000, mid: 7500, high: 9000, identity: 0.8, condition: 0.74, willingness: .openToOffers),
        item("i5", "Pokemon Scarlet Elite Trainer Box", brand: "Pokemon", category: "trading_cards", grade: .a, low: 4500, mid: 5200, high: 6000, identity: 0.93, condition: 0.95),
        item("i6", "Dune, 6-book hardcover set", brand: "Ace", category: "books", grade: .b, low: 3000, mid: 3800, high: 4800, identity: 0.86, condition: 0.78),
    ]

    static let batmobile = item(
        "x1", "LEGO Batmobile 76188", brand: "LEGO", category: "toys/lego",
        grade: .a, low: 7000, mid: 8500, high: 10000, identity: 0.92, condition: 0.88
    )

    static let you = Person(id: "me", name: "You", hue: 2, rating: 4.9, circle: "Thursday Lego")
    static let maya = Person(id: "p1", name: "Maya", hue: 1, rating: 4.8, circle: "Thursday Lego")
    static let dev = Person(id: "p2", name: "Dev", hue: 3, rating: 5.0, circle: "Studio Office")
    static let jordan = Person(id: "p3", name: "Jordan", hue: 0, rating: 4.9, circle: "Thursday Lego")
    static let priya = Person(id: "p4", name: "Priya", hue: 2, rating: 4.7, circle: "Thursday Lego")
    static let theo = Person(id: "p5", name: "Theo", hue: 3, rating: 4.6, circle: "Studio Office")

    static let ask = Ask(
        id: "a1",
        title: "LEGO Batmobile, the classic TV one",
        detail: "Set 76188. Box not required.",
        status: .prospecting,
        cashCeilingCents: 2000,
        anchor: ValueRange(lowCents: 7000, midCents: 8500, highCents: 10000),
        offerItemIDs: ["i1", "i2"],
        shelvesChecked: 46,
        circlesChecked: 2,
        candidates: 3
    )

    static let deal = DealSheet(
        id: "d1",
        give: [shelf[0], shelf[1]],
        get: [batmobile],
        throwInCents: 1000,
        participants: [you, maya, dev],
        why: "You said you'd give up Zelda for any Batman set, and this one's complete with the minifigs.",
        expiresInHours: 47
    )

    static let circles: [TradeCircle] = [
        TradeCircle(
            id: "c1",
            name: "Thursday Lego Circle",
            focus: "LEGO",
            members: [jordan, maya, priya, dev, theo],
            defaultSpot: "Sightglass Coffee, 7th St",
            inviteURL: URL(string: "https://throwin.app/i/THURSDAY-LEGO")!
        ),
        TradeCircle(
            id: "c2",
            name: "Studio Office",
            focus: "Games and sneakers",
            members: [dev, theo, priya],
            defaultSpot: "Office lobby, 3rd floor",
            inviteURL: URL(string: "https://throwin.app/i/STUDIO-OFFICE")!
        ),
    ]

    static let tasteFacts: [TasteFact] = [
        TasteFact(id: "t1", text: "Into LEGO DC sets and Switch games", source: "Intake chat"),
        TasteFact(id: "t2", text: "Would never trade the Millennium Falcon", source: "Intake chat"),
        TasteFact(id: "t3", text: "Fine adding up to $20 for the right set", source: "Batmobile Ask"),
        TasteFact(id: "t4", text: "Doesn't care about boxes for games", source: "Shelf edits"),
        TasteFact(id: "t5", text: "Prefers handoffs at the office lobby", source: "Intake chat"),
    ]

    static let prospectingLines = [
        "Checking 46 Shelves in 2 Circles",
        "Asking Maya's GM about 1 set",
        "Found 3 possible Loops",
        "Balancing a 3-way trade",
    ]
}
