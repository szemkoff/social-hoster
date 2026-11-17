import { describe, expect, it } from "vitest";

import { buildLatePostBody } from "@/lib/pipeline/publisher";
import {
  normalizePostPublishMetadata,
  normalizeTrialReelStrategy,
  resolveInstagramContentType,
  resolvePlatformOverride,
} from "@/lib/post-publish-metadata";

describe("Instagram Trial Reels", () => {
  it("normalizes trial reel strategy inputs", () => {
    expect(normalizeTrialReelStrategy(true)).toBe("MANUAL");
    expect(normalizeTrialReelStrategy("manual")).toBe("MANUAL");
    expect(normalizeTrialReelStrategy("SS_PERFORMANCE")).toBe("SS_PERFORMANCE");
    expect(normalizeTrialReelStrategy("auto")).toBe("SS_PERFORMANCE");
    expect(
      normalizeTrialReelStrategy({ graduationStrategy: "SS_PERFORMANCE" })
    ).toBe("SS_PERFORMANCE");
    expect(normalizeTrialReelStrategy(false)).toBeUndefined();
    expect(normalizeTrialReelStrategy("nope")).toBeUndefined();
  });

  it("reads trialReel and trial_reel format from stored overrides", () => {
    const metadata = normalizePostPublishMetadata({
      platformOverrides: {
        instagram: { caption: "a", trialReel: "auto" },
        "ig-2": { format: "trial_reel" },
      },
    });
    expect(
      resolvePlatformOverride(metadata, { id: "x", type: "instagram" }).trialReel
    ).toBe("SS_PERFORMANCE");
    expect(
      resolvePlatformOverride(metadata, { id: "ig-2", type: "instagram" }).trialReel
    ).toBe("MANUAL");
  });

  it("forces reel content type for trial reels", () => {
    expect(
      resolveInstagramContentType({
        platformType: "instagram",
        contentType: "text",
        trialReel: "MANUAL",
      })
    ).toBe("reel");
    expect(
      resolveInstagramContentType({
        platformType: "instagram",
        format: "trial_reel",
        contentType: "text",
      })
    ).toBe("reel");
  });

  it("sends trialParams to Zernio and drops shareToFeed", () => {
    const body = buildLatePostBody({
      platform: "instagram",
      accountId: "ig-account",
      content: "Trial caption",
      mediaUrl: "https://cdn.example.com/reel.mp4",
      mediaType: "video",
      instagramContentType: "reel",
      trialReel: "SS_PERFORMANCE",
    });
    const entry = (body.platforms as Array<Record<string, unknown>>)[0];
    expect(entry.platformSpecificData).toEqual({
      contentType: "reels",
      trialParams: { graduationStrategy: "SS_PERFORMANCE" },
    });
  });

  it("ignores trial settings on non-reel Instagram posts", () => {
    const body = buildLatePostBody({
      platform: "instagram",
      accountId: "ig-account",
      content: "Feed",
      mediaUrl: "https://cdn.example.com/feed.jpg",
      mediaType: "image",
      instagramContentType: "feed",
      trialReel: "MANUAL",
    });
    expect(body.platforms).toEqual([{ platform: "instagram", accountId: "ig-account" }]);
  });
});
