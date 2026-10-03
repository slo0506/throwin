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
        willingness: Willingness = .wouldTrade,
        readiness: ItemReadiness = .showcase,
        photoScore: Int = 80,
        missingAngles: [String] = [],
        model: String? = nil,
        variant: String? = nil,
        description: String? = nil
    ) -> ShelfItem {
        var item = ShelfItem(
            id: id,
            status: .onShelf,
            title: title,
            willingness: willingness,
            category: category,
            brand: brand,
            model: model,
            variant: variant,
            conditionGrade: grade,
            defects: [],
            value: ValueRange(lowCents: low, midCents: mid, highCents: high),
            identityConfidence: identity,
            conditionConfidence: condition,
            isReserved: false,
            thumbnailUrl: nil
        )
        item.readiness = readiness
        item.photoScore = photoScore
        item.studioAllowed = photoScore >= 50
        item.missingAngles = missingAngles
        item.itemDescription = description
        item.openQuestions = questions.filter { $0.itemId == id }.count
        return item
    }

    static let shelf: [ShelfItem] = [
        item(
            "i1", "Zelda: Tears of the Kingdom", brand: "Nintendo", category: "video_games", grade: .a,
            low: 3500, mid: 4200, high: 5000, identity: 0.97, condition: 0.9,
            photoScore: 82, model: "Switch, physical copy",
            description: "The Switch game in its original case, with the map insert. The cartridge and case look clean."
        ),
        item(
            "i2", "Mario Kart 8 Deluxe", brand: "Nintendo", category: "video_games", grade: .b,
            low: 2400, mid: 2800, high: 3300, identity: 0.95, condition: 0.82,
            readiness: .identified, photoScore: 64, missingAngles: ["Front of case", "Back of case"],
            model: "Switch, physical copy",
            description: "Mario Kart 8 Deluxe for Switch in its case. Light wear on the cover art."
        ),
        item(
            "i3", "LEGO Typewriter 21327", brand: "LEGO", category: "toys/lego", grade: .b,
            low: 14000, mid: 16500, high: 19000, identity: 0.88, condition: 0.66,
            readiness: .logged, photoScore: 44, missingAngles: ["Front", "Keys up close", "Paper roller"],
            model: "Ideas 21327",
            description: "A built LEGO Ideas Typewriter. Your GM can't tell yet if every key and the roller are there."
        ),
        item(
            "i4", "Air Jordan 1 Mid, size 10", brand: "Nike", category: "sneakers", grade: .c,
            low: 6000, mid: 7500, high: 9000, identity: 0.8, condition: 0.74, willingness: .openToOffers,
            readiness: .logged, photoScore: 38, missingAngles: ["Side profile", "Both soles", "Size tag"],
            description: "White and black high-tops that look like Air Jordan 1s. Visible creasing on the toe box."
        ),
        item(
            "i5", "Pokemon Scarlet Elite Trainer Box", brand: "Pokemon", category: "trading_cards", grade: .a,
            low: 4500, mid: 5200, high: 6000, identity: 0.93, condition: 0.95,
            photoScore: 88, model: "Scarlet and Violet", variant: "Sealed",
            description: "A sealed Scarlet and Violet Elite Trainer Box. The shrink wrap looks intact."
        ),
        item(
            "i6", "Dune, 6-book hardcover set", brand: "Ace", category: "books", grade: .b,
            low: 3000, mid: 3800, high: 4800, identity: 0.86, condition: 0.78,
            readiness: .identified, photoScore: 46, missingAngles: ["Covers", "Spines", "Copyright page"],
            variant: "Hardcover",
            description: "All 6 original Dune novels in matching hardcovers. Dust jackets have some edge wear."
        ),
    ]

    /// Tune up questions for demo mode, best first.
    static let questions: [Question] = [
        Question(
            id: "q1", itemId: "i4", itemTitle: "Air Jordan 1 Mid, size 10", thumbnailUrl: nil, kind: .choice,
            prompt: "Which of these is it?", options: ["Air Jordan 1 Mid", "Air Jordan 1 High OG", "Not sure"]
        ),
        Question(
            id: "q2", itemId: "i3", itemTitle: "LEGO Typewriter 21327", thumbnailUrl: nil, kind: .yesNo,
            prompt: "Are all the keys and the paper roller there?", options: ["Yes", "No", "Not sure"]
        ),
        Question(
            id: "q3", itemId: "i4", itemTitle: "Air Jordan 1 Mid, size 10", thumbnailUrl: nil, kind: .picker,
            prompt: "What size are they?",
            options: ["8", "8.5", "9", "9.5", "10", "10.5", "11", "11.5", "12", "13"]
        ),
        Question(
            id: "q4", itemId: "i6", itemTitle: "Dune, 6-book hardcover set", thumbnailUrl: nil, kind: .text,
            prompt: "Anything written on the copyright page, like a printing number?", options: []
        ),
        Question(
            id: "q5", itemId: "i3", itemTitle: "LEGO Typewriter 21327", thumbnailUrl: nil, kind: .choice,
            prompt: "Do you still have the box?", options: ["Box and manual", "Just the manual", "Neither"]
        ),
        Question(
            id: "q6", itemId: "i4", itemTitle: "Air Jordan 1 Mid, size 10", thumbnailUrl: nil, kind: .photo,
            prompt: "A photo of the size tag inside the shoe", options: ["Size tag"]
        ),
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
        receive: [batmobile],
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
