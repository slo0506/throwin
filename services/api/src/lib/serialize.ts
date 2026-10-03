import type { Me, ShelfItem } from "@throwin/shared";
import type { ItemRecord, MeRecord } from "../repo/types.js";

export function toMe(r: MeRecord): Me {
  return {
    id: r.id,
    display_name: r.displayName,
    photo_url: r.photoUrl,
    created_at: r.createdAt.toISOString(),
    profile: {
      autonomy_level: r.autonomyLevel,
      notification_prefs: r.notificationPrefs,
      home_area: r.homeArea,
      default_handoff_place_id: r.defaultHandoffPlaceId,
    },
    counts: {
      shelf_items: r.counts.shelfItems,
      active_asks: r.counts.activeAsks,
      circles: r.counts.circles,
    },
  };
}

export function toShelfItem(r: ItemRecord): ShelfItem {
  const hasValue =
    r.valueLowCents !== null && r.valueMidCents !== null && r.valueHighCents !== null;
  return {
    id: r.id,
    status: r.status,
    title: r.title,
    willingness: r.willingness,
    category: r.category,
    brand: r.brand,
    model: r.model,
    variant: r.variant,
    condition_grade: r.conditionGrade,
    defects: r.defects,
    value: hasValue
      ? {
          low_cents: r.valueLowCents as number,
          mid_cents: r.valueMidCents as number,
          high_cents: r.valueHighCents as number,
          currency: "USD",
        }
      : null,
    identity_confidence: r.identityConf,
    condition_confidence: r.conditionConf,
    is_reserved: r.reservedByDealId !== null,
    thumbnail_url: null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}
