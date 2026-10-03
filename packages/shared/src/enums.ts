import { z } from "zod";

// Mirrors the Postgres enums in supabase/migrations/20261003000100_foundations.sql.
// Keep the two in sync: a migration that changes an enum must change this file too.

export const CircleStatus = z.enum(["active", "paused"]);
export const CircleRole = z.enum(["owner", "member"]);
export const ItemStatus = z.enum([
  "draft",
  "needs_photos",
  "on_shelf",
  "reserved",
  "traded",
  "removed",
]);
export const ItemWillingness = z.enum(["would_trade", "open_to_offers", "not_available"]);
export const ConditionGrade = z.enum(["A", "B", "C", "D"]);
export const AskStatus = z.enum([
  "drafting",
  "offering",
  "prospecting",
  "proposed",
  "accepted",
  "fulfilled",
  "expired",
  "cancelled",
]);
export const DealMode = z.enum(["live", "drop"]);
export const DealStatus = z.enum([
  "staged",
  "pending_approvals",
  "approved",
  "scheduling",
  "in_handoff",
  "completed",
  "failed",
  "cancelled",
]);
export const ApprovalStatus = z.enum(["pending", "approved", "declined"]);
export const HandoffStatus = z.enum(["proposed", "confirmed", "done", "no_show", "disputed"]);
export const TasteFactStatus = z.enum(["active", "superseded", "deleted"]);
export const EdgeKind = z.enum(["explicit", "inferred"]);
export const MediaKind = z.enum(["photo", "frame"]);
export const LiaisonMessageType = z.enum(["inquiry", "answer", "counter", "withdraw"]);
export const PaymentStatus = z.enum([
  "requires_authorization",
  "authorized",
  "captured",
  "cancelled",
  "failed",
  "refunded",
]);
export const ReportStatus = z.enum(["open", "reviewing", "actioned", "dismissed"]);
/** "Bring me every deal" vs "Only bring me deals I'm likely to accept". v1 never auto-executes. */
export const AutonomyLevel = z.enum(["every_deal", "likely_accept"]);

export type CircleStatus = z.infer<typeof CircleStatus>;
export type CircleRole = z.infer<typeof CircleRole>;
export type ItemStatus = z.infer<typeof ItemStatus>;
export type ItemWillingness = z.infer<typeof ItemWillingness>;
export type ConditionGrade = z.infer<typeof ConditionGrade>;
export type AskStatus = z.infer<typeof AskStatus>;
export type DealMode = z.infer<typeof DealMode>;
export type DealStatus = z.infer<typeof DealStatus>;
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;
export type HandoffStatus = z.infer<typeof HandoffStatus>;
export type TasteFactStatus = z.infer<typeof TasteFactStatus>;
export type EdgeKind = z.infer<typeof EdgeKind>;
export type MediaKind = z.infer<typeof MediaKind>;
export type LiaisonMessageType = z.infer<typeof LiaisonMessageType>;
export type PaymentStatus = z.infer<typeof PaymentStatus>;
export type ReportStatus = z.infer<typeof ReportStatus>;
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;
