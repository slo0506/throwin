import Foundation

/// Splits text into token-sized chunks (roughly how a model streams): words with their
/// trailing space, long words split in 2.
nonisolated func demoTokens(_ text: String) -> [String] {
    var tokens: [String] = []
    var current = ""
    for character in text {
        current.append(character)
        if character == " " || character == "," || character == "." {
            tokens.append(current)
            current = ""
        } else if current.count >= 7 {
            tokens.append(current)
            current = ""
        }
    }
    if !current.isEmpty {
        tokens.append(current)
    }
    return tokens
}

/// The GM in demo mode: a short scripted conversation that walks the same cards the real GM
/// sends (choices, an Ask card, Item cards, a camera request and the recap), so every screen
/// works with `-demo` and nothing leaves the phone.
struct DemoGM {
    enum Input {
        case text(String)
        case choice(componentID: String, optionIDs: [String])
    }

    enum Beat {
        /// A progress line, held for a moment.
        case think(String, seconds: Double)
        /// Text, streamed token by token.
        case say(String)
        case show(GMComponent)
        case effect(Effect)
    }

    enum Effect {
        case loadShelf
        case upsertAsk(Ask)
    }

    private enum Stage {
        case interests, limits, want, offer, recap, fix, chatWant, chatOffer
    }

    private(set) var mode: GMMode = .chat
    private var stage: Stage = .chatWant
    private var ask: Ask?
    private var counter = 0

    /// The GM's first words when the thread is empty.
    mutating func opening(intake: Bool, firstName: String) -> [Beat] {
        mode = intake ? .intake : .chat
        if intake {
            stage = .interests
            return [
                .say("Hi \(firstName). I'm your GM. I find trades in your Circles so you don't have to. First, what are you into?"),
                .show(choices(
                    "Pick as many as you like",
                    [("lego", "LEGO"), ("switch", "Switch games"), ("sneakers", "Sneakers"), ("cards", "Trading cards"), ("books", "Books")],
                    multiple: true
                )),
            ]
        }
        stage = .chatWant
        return [
            .say("Hey \(firstName). What are you hunting for? Say it any way, like the big LEGO Batmobile."),
            .show(choices(
                "",
                [("batmobile", "The LEGO Batmobile"), ("switch", "A Switch game"), ("desk", "Something for my desk")],
                multiple: false
            )),
        ]
    }

    mutating func respond(to input: Input) -> [Beat] {
        switch stage {
        case .interests:
            stage = .limits
            return [
                .think("Taking notes", seconds: 0.7),
                .say("Good taste. Is there anything you'd never trade, no matter the offer?"),
                .show(choices("", [("falcon", "My Millennium Falcon"), ("none", "Nothing's off limits")], multiple: false)),
            ]
        case .limits:
            stage = .want
            return [
                .think("Taking notes", seconds: 0.6),
                .say("Got it. That stays off the table. Last 1: what's 1 thing you want right now? Say it any way."),
            ]
        case .want:
            stage = .offer
            return wantBeats(intake: true)
        case .chatWant:
            stage = .chatOffer
            return wantBeats(intake: false)
        case .offer:
            stage = .recap
            let offer = settleOffer(input)
            return [
                .think("Pricing your offer", seconds: 0.9),
                .effect(.upsertAsk(offer)),
                .say(offerLine(offer) + " Before I start, here's what I heard. Check me."),
                .show(recap()),
            ]
        case .chatOffer:
            stage = .chatWant
            let offer = settleOffer(input)
            return [
                .think("Checking 46 Shelves in 2 Circles", seconds: 1.2),
                .effect(.upsertAsk(offer)),
                .say(offerLine(offer) + " I'm on it, and I'll tell you when I find a deal."),
                .show(GMComponent(id: nextID(), body: .askCard(offer))),
            ]
        case .recap:
            if case let .choice(_, optionIDs) = input, optionIDs.contains(RecapData.looksRight) {
                stage = .chatWant
                mode = .chat
                return [.say("Great. I'm on it, and I'll keep checking your Circles.")]
            }
            stage = .fix
            return [.say("What did I get wrong? Tell me in your own words.")]
        case .fix:
            stage = .recap
            return [
                .think("Updating my notes", seconds: 0.8),
                .say("Thanks, fixed. Here's the update."),
                .show(recap()),
            ]
        }
    }

    // MARK: Beats

    private mutating func wantBeats(intake: Bool) -> [Beat] {
        var ask = DemoData.ask
        if !intake {
            ask.id = "demo-ask-\(nextID())"
        }
        ask.status = .offering
        ask.statusLine = AskStatus.offering.fallbackLine
        ask.offerItemIds = []
        ask.offerValue = nil
        self.ask = ask

        let offerable = Array(DemoData.shelf.prefix(3)).map { GMItem(item: $0) }
        var beats: [Beat] = [
            .think("Looking it up", seconds: 0.9),
            .think("Checking used prices", seconds: 0.8),
            .say("That's the classic TV Batmobile, set 76188. It usually trades for $70 to $100 used."),
            .show(GMComponent(id: nextID(), body: .askCard(ask))),
            .effect(.upsertAsk(ask)),
            .effect(.loadShelf),
            .say("What would you offer? These come close. Tap to pick."),
            .show(GMComponent(id: nextID(), body: .itemCards(ItemCardsData(
                items: offerable,
                selectable: true,
                selectedIds: ["i1", "i2"]
            )))),
        ]
        if intake {
            beats.append(.show(GMComponent(id: nextID(), body: .cameraRequest(CameraRequestData(
                instruction: "Or snap 2 or 3 things you'd trade, like a shelf of games.",
                itemId: nil
            )))))
        }
        return beats
    }

    /// The offer the user picked, or Zelda and Mario Kart when they answered another way.
    private mutating func settleOffer(_ input: Input) -> Ask {
        var ask = self.ask ?? DemoData.ask
        var ids = ["i1", "i2"]
        if case let .choice(_, optionIDs) = input, !optionIDs.isEmpty {
            ids = optionIDs
        }
        let values = DemoData.shelf.filter { ids.contains($0.id) }.compactMap(\.value)
        ask.offerItemIds = ids
        ask.offerValue = CentsRange(
            lowCents: values.reduce(0) { $0 + $1.lowCents },
            highCents: values.reduce(0) { $0 + $1.highCents }
        )
        ask.status = .prospecting
        ask.statusLine = DemoData.prospectingLines[0]
        self.ask = ask
        return ask
    }

    private func offerLine(_ ask: Ask) -> String {
        guard let value = ask.offerValue else { return "Got it." }
        return "Your offer is worth about \(Money.range(low: value.lowCents, high: value.highCents))."
    }

    private mutating func recap() -> GMComponent {
        GMComponent(id: nextID(), body: .recap(RecapData(
            paragraph: "You're into LEGO and Switch games, and you're hunting the classic TV Batmobile. The Millennium Falcon never leaves your Shelf. You'd add up to $20 cash for the right set, and you want to see every deal before anything happens.",
            sampleDecisions: [
                SampleDecision(give: "Zelda", get: "LEGO Batmobile 76188", verdict: "yes", why: "Close in value, and games are fair game."),
                SampleDecision(give: "Zelda and Mario Kart", get: "A Batmobile missing pieces", verdict: "no", why: "You want it complete."),
                SampleDecision(give: "Millennium Falcon", get: "Anything", verdict: "no", why: "You said never."),
            ]
        )))
    }

    private mutating func choices(_ prompt: String, _ options: [(String, String)], multiple: Bool) -> GMComponent {
        GMComponent(id: nextID(), body: .choices(ChoicesData(
            prompt: prompt,
            options: options.map { ChoiceOption(id: $0.0, label: $0.1) },
            multiple: multiple
        )))
    }

    private mutating func nextID() -> String {
        counter += 1
        return "demo-\(counter)"
    }
}
