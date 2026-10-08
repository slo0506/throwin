import Foundation

/// Home's "Next up": what needs you, best first, worked out on the server across Deals, the
/// Shelf and Asks (`GET /v1/next-up`). Unknown kinds from a newer server are dropped.
nonisolated struct NextUpItem: Decodable, Identifiable, Hashable, Sendable {
    enum Kind: String, Decodable, Sendable {
        case answerCounter = "answer_counter"
        case approveDeal = "approve_deal"
        case showcasePhotos = "showcase_photos"
        case pinDownItem = "pin_down_item"
        case answerInquiry = "answer_inquiry"
        case someoneWants = "someone_wants"
        case offerForAsk = "offer_for_ask"
        case joinCircle = "join_circle"
        case weakOffer = "weak_offer"
        case inDemand = "in_demand"
        case tuneUp = "tune_up"
        case itemPhotos = "item_photos"
        case addToShelf = "add_to_shelf"
        case newAsk = "new_ask"
    }

    var id: String
    var kind: Kind
    var title: String
    var detail: String
    var cta: String
    var dealId: String?
    var askId: String?
    var itemId: String?
    var angles: [String]
    var thumbnailUrl: String?
    var expiresAt: String?
}

nonisolated struct NextUpResponse: Decodable, Sendable {
    var items: [NextUpItem]

    enum CodingKeys: String, CodingKey { case items }

    /// Skips items this build doesn't know how to show.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var list = try c.nestedUnkeyedContainer(forKey: .items)
        var items: [NextUpItem] = []
        while !list.isAtEnd {
            if let item = try? list.decode(NextUpItem.self) {
                items.append(item)
            } else {
                _ = try? list.decode(Skip.self)
            }
        }
        self.items = items
    }

    private struct Skip: Decodable {}
}
