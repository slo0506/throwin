import { AnswerResponse, QuestionsResponse, ShelfItem } from "@throwin/shared";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, errorCode, makeHarness } from "./helpers.js";

const SNEAKER = "aaaaaaaa-0000-4000-8000-0000000000c1";
const CONSOLE = "aaaaaaaa-0000-4000-8000-0000000000c2";
const Q_BRAND = "cccccccc-0000-4000-8000-000000000001";
const Q_SIZE = "cccccccc-0000-4000-8000-000000000002";
const Q_PHOTO = "cccccccc-0000-4000-8000-000000000003";
const Q_TAG = "cccccccc-0000-4000-8000-000000000004";
const Q_STORAGE = "cccccccc-0000-4000-8000-000000000005";

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing test fixture");
  return value;
}

function setup() {
  const h = makeHarness();
  h.repo.addItem({
    id: SNEAKER,
    ownerId: ALICE,
    title: "White high-top sneakers",
    identityConf: 0.55,
    valueLowCents: 4000,
    valueMidCents: 6500,
    valueHighCents: 9000,
    thumbnailPath: `${ALICE}/c/crops/0.jpg`,
  });
  h.repo.addItem({
    id: CONSOLE,
    ownerId: ALICE,
    title: "PlayStation 5 Slim",
    identityConf: 0.93,
    valueLowCents: 30000,
    valueMidCents: 34000,
    valueHighCents: 38000,
    photoScore: 62,
    photoIssues: ["missing_angles", "not_a_code"],
    missingAngles: ["Ports"],
  });
  const at = (m: number) => new Date(Date.UTC(2026, 9, 3, 0, m));
  h.repo.addQuestion({
    id: Q_PHOTO,
    itemId: SNEAKER,
    kind: "photo",
    prompt: "Photo of the size tag",
    options: [],
    driver: "model",
    impact: 0.9,
    createdAt: at(1),
  });
  h.repo.addQuestion({
    id: Q_SIZE,
    itemId: SNEAKER,
    kind: "picker",
    prompt: "What size?",
    options: ["9", "9.5", "10"],
    driver: "size",
    impact: 0.5,
    createdAt: at(2),
  });
  h.repo.addQuestion({
    id: Q_BRAND,
    itemId: SNEAKER,
    kind: "yes_no",
    prompt: "Is this Nike?",
    driver: "brand",
    impact: 0.7,
    createdAt: at(3),
  });
  h.repo.addQuestion({
    id: Q_TAG,
    itemId: SNEAKER,
    kind: "text",
    prompt: "Anything written on the tag?",
    options: [],
    driver: "colorway",
    impact: 0.3,
    createdAt: at(4),
  });
  h.repo.addQuestion({
    id: Q_STORAGE,
    itemId: CONSOLE,
    kind: "choice",
    prompt: "Which storage?",
    options: ["825GB", "1TB", "Not sure"],
    driver: "storage",
    impact: 0.2,
    createdAt: at(5),
  });
  return h;
}

describe("ShelfItem readiness fields", () => {
  it("projects readiness, photo quality and the question summary", async () => {
    const h = setup();
    const body = await (await h.request("/v1/items", { as: ALICE })).json();
    const items = body.items.map((i: unknown) => ShelfItem.parse(i));
    const sneaker = items.find((i: ShelfItem) => i.id === SNEAKER);
    const ps5 = items.find((i: ShelfItem) => i.id === CONSOLE);
    expect(sneaker).toMatchObject({
      readiness: "logged",
      photo_score: null,
      studio_allowed: false,
      open_questions: 4,
      // The best open question: yes_no at 0.7 per tap.
      follow_up: "Is this Nike?",
    });
    expect(ps5).toMatchObject({
      readiness: "identified",
      photo_score: 62,
      studio_allowed: true,
      photo_issues: ["missing_angles"],
      missing_angles: ["Ports"],
      open_questions: 1,
      description: null,
    });
  });

  it("pins identity on PATCH confirm and recomputes readiness", async () => {
    const h = setup();
    Object.assign(must(h.repo.items[0]), { valueMidCents: 5000, valueHighCents: 6400 });
    const res = await h.request(`/v1/items/${SNEAKER}`, {
      method: "PATCH",
      body: JSON.stringify({ confirm: true }),
      as: ALICE,
    });
    expect(ShelfItem.parse(await res.json()).readiness).toBe("identified");
  });
});

describe("GET /v1/questions", () => {
  it("lists open questions best first by impact over effort, with thumbnails", async () => {
    const h = setup();
    const res = await h.request("/v1/questions", { as: ALICE });
    expect(res.status).toBe(200);
    const { questions } = QuestionsResponse.parse(await res.json());
    expect(questions.map((q) => q.id)).toEqual([Q_BRAND, Q_SIZE, Q_STORAGE, Q_PHOTO, Q_TAG]);
    expect(questions[0]).toMatchObject({
      item_id: SNEAKER,
      item_title: "White high-top sneakers",
      kind: "yes_no",
      options: ["Yes", "No", "Not sure"],
    });
    expect(questions[0]?.thumbnail_url).toContain(`${ALICE}/c/crops/0.jpg`);
    expect(questions.find((q) => q.id === Q_STORAGE)?.thumbnail_url).toBeNull();
  });

  it("filters by Item, hides other users' and closed questions, and caps at 20", async () => {
    const h = setup();
    const one = QuestionsResponse.parse(
      await (await h.request(`/v1/questions?item_id=${CONSOLE}`, { as: ALICE })).json(),
    );
    expect(one.questions.map((q) => q.id)).toEqual([Q_STORAGE]);
    const bob = QuestionsResponse.parse(
      await (await h.request("/v1/questions", { as: BOB })).json(),
    );
    expect(bob.questions).toEqual([]);

    must(h.repo.questions[0]).status = "answered";
    for (let i = 0; i < 30; i++) {
      h.repo.addQuestion({
        id: `dddddddd-0000-4000-8000-${String(i).padStart(12, "0")}`,
        itemId: CONSOLE,
        driver: `d${i}`,
      });
    }
    const all = QuestionsResponse.parse(
      await (await h.request("/v1/questions", { as: ALICE })).json(),
    );
    expect(all.questions).toHaveLength(20);
    expect(all.questions.map((q) => q.id)).not.toContain(Q_PHOTO);
  });

  it("rejects a malformed item_id or unknown parameters", async () => {
    const h = setup();
    expect((await h.request("/v1/questions?item_id=nope", { as: ALICE })).status).toBe(400);
    expect((await h.request("/v1/questions?sort=new", { as: ALICE })).status).toBe(400);
  });
});

describe("POST /v1/questions/:id/answer", () => {
  it("answers, flags the Item and enqueues refine_item", async () => {
    const h = setup();
    const res = await h.request(`/v1/questions/${Q_BRAND}/answer`, {
      ...post({ answer: "Yes" }),
      as: ALICE,
    });
    expect(res.status).toBe(202);
    const { item } = AnswerResponse.parse(await res.json());
    expect(item).toMatchObject({
      id: SNEAKER,
      is_appraising: true,
      open_questions: 3,
      follow_up: "What size?",
    });
    expect(h.repo.questions.find((q) => q.id === Q_BRAND)).toMatchObject({
      status: "answered",
      answer: { value: "Yes" },
    });
    expect(h.repo.jobs).toEqual([
      { kind: "refine_item", payload: { item_id: SNEAKER, user_id: ALICE, reason: "answer" } },
    ]);
  });

  it("skips, and does not queue a second pass while 1 is waiting", async () => {
    const h = setup();
    await h.request(`/v1/questions/${Q_BRAND}/answer`, { ...post({ answer: "No" }), as: ALICE });
    const res = await h.request(`/v1/questions/${Q_SIZE}/answer`, {
      ...post({ skip: true }),
      as: ALICE,
    });
    expect(res.status).toBe(202);
    expect(h.repo.questions.find((q) => q.id === Q_SIZE)).toMatchObject({
      status: "skipped",
      skipCount: 1,
    });
    expect(h.repo.jobs).toHaveLength(1);
  });

  it("checks answers against the question's kind", async () => {
    const h = setup();
    const notAnOption = await h.request(`/v1/questions/${Q_SIZE}/answer`, {
      ...post({ answer: "11" }),
      as: ALICE,
    });
    expect(notAnOption.status).toBe(400);
    expect(await errorCode(notAnOption)).toBe("validation_error");
    const text = await h.request(`/v1/questions/${Q_TAG}/answer`, {
      ...post({ answer: "Swoosh, 10" }),
      as: ALICE,
    });
    expect(text.status).toBe(202);
    const tooLong = await h.request(`/v1/questions/${Q_STORAGE}/answer`, {
      ...post({ answer: "x".repeat(201) }),
      as: ALICE,
    });
    expect(tooLong.status).toBe(400);
    for (const body of [
      {},
      { answer: "Yes", skip: true },
      { skip: false },
      { answer: "Yes", extra: 1 },
    ]) {
      const res = await h.request(`/v1/questions/${Q_BRAND}/answer`, { ...post(body), as: ALICE });
      expect(res.status).toBe(400);
    }
    expect(h.repo.jobs).toHaveLength(1);
  });

  it("sends photo questions to the media upload, but lets them be skipped", async () => {
    const h = setup();
    const res = await h.request(`/v1/questions/${Q_PHOTO}/answer`, {
      ...post({ answer: "done" }),
      as: ALICE,
    });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("use_media_upload");
    const skip = await h.request(`/v1/questions/${Q_PHOTO}/answer`, {
      ...post({ skip: true }),
      as: ALICE,
    });
    expect(skip.status).toBe(202);
  });

  it("is a 409 when already answered or the Item is reserved, and a 404 otherwise", async () => {
    const h = setup();
    await h.request(`/v1/questions/${Q_BRAND}/answer`, { ...post({ answer: "Yes" }), as: ALICE });
    const again = await h.request(`/v1/questions/${Q_BRAND}/answer`, {
      ...post({ answer: "No" }),
      as: ALICE,
    });
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("already_answered");

    const ps5 = must(h.repo.items.find((i) => i.id === CONSOLE));
    ps5.status = "reserved";
    ps5.reservedByDealId = "deal-1";
    const held = await h.request(`/v1/questions/${Q_STORAGE}/answer`, {
      ...post({ answer: "1TB" }),
      as: ALICE,
    });
    expect(held.status).toBe(409);
    expect(await errorCode(held)).toBe("item_reserved");

    const asBob = await h.request(`/v1/questions/${Q_SIZE}/answer`, {
      ...post({ answer: "10" }),
      as: BOB,
    });
    expect(asBob.status).toBe(404);
    expect(await errorCode(asBob)).toBe("not_found");
    expect(
      (await h.request("/v1/questions/nope/answer", { ...post({ answer: "10" }), as: ALICE }))
        .status,
    ).toBe(404);
  });
});
