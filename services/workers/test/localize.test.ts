import type Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ClaudeVision, DEFAULT_PRICING } from "../src/appraiser/claude.js";
import {
  type Box,
  boxArea,
  contextRegion,
  fromRegion,
  isDegenerate,
  type PreparedImage,
  prepare,
  withGrid,
} from "../src/appraiser/images.js";
import {
  appraiseCapture,
  type Located,
  localize,
  pickHero,
  titleOverlap,
} from "../src/appraiser/pipeline.js";
import { silentLogger } from "../src/log.js";
import {
  CAPTURE,
  checkerJpeg,
  embedder,
  fakeVision,
  identification,
  setup,
  solidJpeg,
} from "./support.js";

const near = (a: Box, b: Box) => {
  for (const [i, v] of a.entries()) expect(v).toBeCloseTo(b[i] as number, 6);
};

describe("contextRegion", () => {
  it("pads by at least 35% of the box, 20% of the frame, and spans at least 30%", () => {
    // A small box near the middle: the frame margin wins.
    near(contextRegion([0.45, 0.45, 0.55, 0.55]), [0.25, 0.25, 0.75, 0.75]);
    // A big box: 35% of its own size wins.
    const big = contextRegion([0.2, 0.2, 0.8, 0.8]);
    near(big, [0, 0, 1, 1]);
    for (const box of [
      [0.45, 0.45, 0.55, 0.55],
      [0.3, 0.1, 0.4, 0.2],
      [0.9, 0.9, 0.99, 0.99],
    ] as Box[]) {
      const r = contextRegion(box);
      expect(r[2] - r[0]).toBeGreaterThanOrEqual(0.3);
      expect(r[3] - r[1]).toBeGreaterThanOrEqual(0.3);
      // The detector's box is always inside, with room around it.
      expect(r[0]).toBeLessThanOrEqual(box[0]);
      expect(r[2]).toBeGreaterThanOrEqual(box[2]);
    }
  });

  it("shifts at the frame's edges instead of shrinking", () => {
    const r = contextRegion([0.9, 0.0, 1.0, 0.1]);
    expect(r[2]).toBe(1);
    expect(r[1]).toBe(0);
    expect(r[2] - r[0]).toBeCloseTo(0.5, 6);
  });

  it("covers a detector box that is a fifth of the frame too high", () => {
    // AirPods Max on the nightstand: real box about [0.27, 0.62, 0.56, 0.78].
    const r = contextRegion([0.27, 0.42, 0.56, 0.58]);
    expect(r[1]).toBeLessThanOrEqual(0.62);
    expect(r[3]).toBeGreaterThanOrEqual(0.78);
  });
});

describe("localize", () => {
  const closeUps = [
    { frame: 1, region: [0.2, 0.2, 0.6, 0.6] as Box, detectorBox: [0.3, 0.3, 0.5, 0.5] as Box },
    { frame: 0, region: [0, 0, 0.5, 0.5] as Box, detectorBox: [0.1, 0.1, 0.3, 0.3] as Box },
  ];

  it("maps a box in a close-up back to the frame", () => {
    near(fromRegion([0.25, 0.25, 0.75, 0.75], [0.2, 0.2, 0.6, 0.6]), [0.3, 0.3, 0.5, 0.5]);
    const located = localize(
      closeUps,
      identification({
        box_in_crop: [
          { crop: 2, box: [0.5, 0.5, 1, 1] },
          { crop: 1, box: [0, 0.5, 0.5, 1] },
        ],
      }),
    );
    expect(located.map((l) => [l.frame, l.source])).toEqual([
      [1, "refined"],
      [0, "refined"],
    ]);
    near((located[0] as Located).box, [0.2, 0.4, 0.4, 0.6]);
    near((located[1] as Located).box, [0.25, 0.25, 0.5, 0.5]);
  });

  it("falls back to the detector's box when the refined box is missing or degenerate", () => {
    expect(isDegenerate([0, 0, 1, 1])).toBe(true);
    expect(isDegenerate([0.4, 0.4, 0.41, 0.9])).toBe(true);
    expect(isDegenerate([0.2, 0.2, 0.6, 0.7])).toBe(false);
    const located = localize(
      closeUps,
      identification({ box_in_crop: [{ crop: 1, box: [0, 0, 1, 1] }] }),
    );
    expect(located).toEqual([
      { frame: 1, box: [0.3, 0.3, 0.5, 0.5], source: "detector" },
      { frame: 0, box: [0.1, 0.1, 0.3, 0.3], source: "detector" },
    ]);
    expect(localize(closeUps, identification())[0]?.source).toBe("detector");
  });
});

describe("pickHero", () => {
  const sharp = (frame: number) => [10, 50, 0][frame] ?? 0;

  it("scores refined boxes by area times frame sharpness", () => {
    const hero = pickHero(
      [
        { frame: 0, box: [0, 0, 0.5, 0.5], source: "refined" }, // 0.25 x 11
        { frame: 1, box: [0, 0, 0.3, 0.3], source: "refined" }, // 0.09 x 51
        { frame: 2, box: [0, 0, 0.9, 0.9], source: "refined" }, // 0.81 x 1
      ],
      sharp,
    );
    expect(hero.frame).toBe(1);
  });

  it("prefers any refined box over coarse detector boxes", () => {
    const hero = pickHero(
      [
        { frame: 1, box: [0, 0, 0.9, 0.9], source: "detector" },
        { frame: 0, box: [0, 0, 0.2, 0.2], source: "refined" },
      ],
      sharp,
    );
    expect(hero).toMatchObject({ frame: 0, source: "refined" });
  });
});

describe("appraiseCapture localization", () => {
  const detection = {
    objects: [
      {
        label: "water bottle",
        category: "accessories",
        appearances: [{ frame: 1, box: [0.1, 0.1, 0.3, 0.3] as Box }],
      },
    ],
  };

  it("cuts the hero crop at the refined box and stores it in crop_box", async () => {
    const store = await setup();
    const vision = fakeVision(detection, [
      identification({
        title: "Hydro Flask 32 oz",
        box_in_crop: [{ crop: 1, box: [0.25, 0.25, 0.75, 0.75] }],
      }),
    ]);
    let closeUp: PreparedImage | undefined;
    const identify = vision.identify.bind(vision);
    vision.identify = async (crops, frame, hint) => {
      closeUp = crops[0];
      return identify(crops, frame, hint);
    };
    await appraiseCapture(CAPTURE, { store, vision, embedder, logger: silentLogger });

    // The close-up is the context region [0, 0, 0.6, 0.6] of the 1600 x 1200 source frame.
    expect(closeUp?.width).toBe(960);
    const item = store.items[0];
    expect(item?.cropBox.frame).toBe(1);
    expect(item?.cropBox.source).toBe("refined");
    near(item?.cropBox.box as Box, [0.15, 0.15, 0.45, 0.45]);
    // Refined box 0.3 of 1600 px wide, plus 8% padding a side, from the full-size frame.
    expect(item?.crop.width).toBeGreaterThan(540);
    expect(item?.crop.width).toBeLessThan(580);
  });

  it("falls back to the detector's box when the model's box is degenerate", async () => {
    const store = await setup();
    const vision = fakeVision(detection, [
      identification({ box_in_crop: [{ crop: 1, box: [0.5, 0.5, 0.51, 0.51] }] }),
    ]);
    await appraiseCapture(CAPTURE, { store, vision, embedder, logger: silentLogger });
    expect(store.items[0]?.cropBox).toEqual({
      frame: 1,
      box: [0.1, 0.1, 0.3, 0.3],
      source: "detector",
    });
  });
});

/** A fake Messages API that answers each kind of call and records what it was sent. */
function fakeClient() {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const answers: Record<string, unknown> = {
    detect: { objects: [] },
    group: {
      groups: [
        { members: [1, 3], reason: "same pair" },
        { members: [2], reason: "alone" },
        { members: [9, 2], reason: "no candidate 9" },
      ],
    },
    identify: {
      is_tradeable_item: true,
      title: "AirPods Max",
      category: "electronics",
      brand: "Apple",
      model: null,
      variant: null,
      attributes: [],
      condition_grade: "B",
      defects: [],
      age_estimate_years: null,
      identity_confidence: 0.9,
      condition_confidence: 0.8,
      follow_up: null,
      box_in_crop: [{ crop: 1, box: [0.3, 0.6, 0.7, 0.95] }],
    },
  };
  const client = {
    messages: {
      async create(params: Anthropic.MessageCreateParamsNonStreaming) {
        calls.push(params);
        const system = String(params.system);
        const kind = system.includes("double counting")
          ? "group"
          : system.includes("You find tradeable")
            ? "detect"
            : "identify";
        return {
          content: [{ type: "text", text: JSON.stringify(answers[kind]) }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1000, output_tokens: 100 },
        };
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

const images = (params: Anthropic.MessageCreateParamsNonStreaming) => {
  const content = params.messages[0]?.content as Anthropic.ContentBlockParam[];
  return content.flatMap((b) =>
    b.type === "image" && b.source.type === "base64" ? [b.source.data] : [],
  );
};
const texts = (params: Anthropic.MessageCreateParamsNonStreaming) => {
  const content = params.messages[0]?.content as Anthropic.ContentBlockParam[];
  return content.flatMap((b) => (b.type === "text" ? [b.text] : []));
};

describe("ClaudeVision localization calls", () => {
  it("draws the grid on detection images only when enabled", async () => {
    const frame = await prepare(await checkerJpeg(800, 600));
    const on = fakeClient();
    await new ClaudeVision(on.client).detect([frame]);
    expect(images(on.calls[0] as Anthropic.MessageCreateParamsNonStreaming)[0]).not.toBe(
      frame.jpeg.toString("base64"),
    );
    expect(String(on.calls[0]?.system)).toContain("light grid");

    const off = fakeClient();
    await new ClaudeVision(off.client, () => {}, DEFAULT_PRICING, { detectGrid: false }).detect([
      frame,
    ]);
    expect(images(off.calls[0] as Anthropic.MessageCreateParamsNonStreaming)[0]).toBe(
      frame.jpeg.toString("base64"),
    );
    expect(String(off.calls[0]?.system)).not.toContain("light grid");
  });

  it("keeps the grid off close-ups and numbers them for box_in_crop", async () => {
    const crop = await prepare(await solidJpeg("#335577", 900, 700));
    const wide = await prepare(await solidJpeg("#775533", 1000, 750));
    const { client, calls } = fakeClient();
    const read = await new ClaudeVision(client).identify([crop, crop], wide, "headphones");
    const call = calls[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(images(call)).toEqual([
      crop.jpeg.toString("base64"),
      crop.jpeg.toString("base64"),
      wide.jpeg.toString("base64"),
    ]);
    expect(texts(call)).toEqual(expect.arrayContaining(["Close-up 1:", "Close-up 2:"]));
    expect(read.box_in_crop).toEqual([{ crop: 1, box: [0.3, 0.6, 0.7, 0.95] }]);
  });

  it("sends a numbered contact sheet with small thumbnails and maps groups back", async () => {
    const crop = await prepare(await solidJpeg("#ffcc00", 1000, 800));
    const { client, calls } = fakeClient();
    const groups = await new ClaudeVision(client).group(
      ["Yellow clogs", "White sneakers", "Yellow Crocs Classic Clog"].map((title, i) => ({
        crop,
        title,
        frames: [i, i + 2],
      })),
    );
    // [1, 3] becomes [0, 2]; a single member or a number past the sheet is dropped.
    expect(groups).toEqual([[0, 2]]);
    const call = calls[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(call.model).toContain("haiku");
    expect(texts(call)[0]).toBe('Candidate 1: "Yellow clogs", seen in frames 0, 2');
    for (const data of images(call)) {
      const meta = await sharp(Buffer.from(data, "base64")).metadata();
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(384);
    }
    expect(await new ClaudeVision(client).group([{ crop, title: "x", frames: [0] }])).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("withGrid", () => {
  it("keeps the size and only lightly marks the image", async () => {
    const frame = await prepare(await solidJpeg("#808080", 1000, 750));
    const gridded = await withGrid(frame);
    expect([gridded.width, gridded.height]).toEqual([1000, 750]);
    const { channels } = await sharp(gridded.jpeg).stats();
    // Mostly the original gray; the lines and labels move the mean only a little.
    expect(Math.abs((channels[0]?.mean ?? 0) - 128)).toBeLessThan(12);
    expect(channels[0]?.stdev ?? 0).toBeGreaterThan(1);
  });
});

describe("titleOverlap", () => {
  it("is the Jaccard share of title words", () => {
    expect(titleOverlap("LEGO Moon Rover", "lego moon rover set")).toBeCloseTo(0.75);
    expect(boxArea([0, 0, 0.5, 0.5])).toBe(0.25);
  });
});
