import "server-only";

import crypto from "node:crypto";
import { and, asc, eq, lte } from "drizzle-orm";
import { db } from "@/db";
import {
  pipelineRuns,
  platforms,
  posts,
  postTargets,
  workspaceMemberships,
  workspaces,
} from "@/db/schema";
import type { PipelineStep } from "@/db/schema";
import { getLatestApprovalRequestForPost } from "@/lib/approval-requests";
import { normalizeApprovalWorkflowMode, shouldBlockPublishForApproval } from "@/lib/approvals";
import { sendNotificationEmail } from "@/lib/notifications/send";
import { publishPlatformTargets } from "@/lib/pipeline/publish-service";
import type { PublishResult } from "@/lib/pipeline/publisher";
import {
  resolvePostStatusFromTargetResults,
  resolvePublishResultsStatus,
} from "@/lib/pipeline/status";
import {
  normalizePostPublishMetadata,
  resolveInstagramContentType,
  resolvePlatformMediaUrls,
  resolvePlatformOverride,
} from "@/lib/post-publish-metadata";
import { trackUsage } from "@/lib/usage";

type PostRow = typeof posts.$inferSelect;

export type ExecutePostPublishInput = {
  post: PostRow;
  workspaceId: string;
  /** User to notify on target failures. Optional for background publishing. */
  notifyUserId?: string | null;
  trigger: "api" | "cron";
};

export type ExecutePostPublishResult =
  | { ok: false; error: string; status: number }
  | {
      ok: true;
      runId: string;
      steps: PipelineStep[];
      runStatus: ReturnType<typeof resolvePublishResultsStatus>;
      postStatus: string;
      targetCount: number;
    };

/**
 * Publishes every target of a saved post and records the pipeline run.
 * Shared by POST /api/posts/[id]/publish and the due-post worker so a post
 * scheduled for later goes through exactly the same pipeline as "Publish now".
 */
export async function executePostPublish(
  input: ExecutePostPublishInput
): Promise<ExecutePostPublishResult> {
  const { post, workspaceId } = input;
  const postId = post.id;

  const targets = db
    .select({ target: postTargets, platform: platforms })
    .from(postTargets)
    .innerJoin(platforms, eq(postTargets.platformId, platforms.id))
    .where(eq(postTargets.postId, postId))
    .all();

  if (targets.length === 0) {
    return { ok: false, error: "No platform targets for this post", status: 400 };
  }

  const runId = crypto.randomUUID();
  const now = new Date();
  const steps: PipelineStep[] = [];

  await db.insert(pipelineRuns).values({
    id: runId,
    workspaceId,
    scheduleId: null,
    postId,
    trigger: input.trigger,
    status: "running",
    steps: [],
    startedAt: now,
  });

  await db.update(posts).set({ status: "publishing", updatedAt: now }).where(eq(posts.id, postId));

  const results: PublishResult[] = [];
  const publishMetadata = normalizePostPublishMetadata(post.metadata);

  for (const { target, platform } of targets) {
    if (input.trigger === "cron" && target.status === "published") {
      // Background retries never re-post a target that is already live.
      results.push({
        platform: platform.type,
        provider: platform.provider === "bird" ? "bird" : platform.provider === "direct" ? "direct" : "late",
        accountId: platform.accountId ?? null,
        success: true,
        classification: "success",
        postId: target.platformPostId ?? undefined,
        postUrl: target.publishedUrl ?? undefined,
      } as PublishResult);
      continue;
    }

    const stepName = `publish:${platform.type}`;
    const stepStart = new Date();
    const override = resolvePlatformOverride(publishMetadata, platform);
    const platformMediaUrls = resolvePlatformMediaUrls(publishMetadata, platform, post.mediaUrl);
    const platformMediaUrl = platformMediaUrls[0] ?? undefined;
    const instagramContentType = resolveInstagramContentType({
      platformType: platform.type,
      format: override.format,
      contentType: post.contentType,
      mediaUrlCount: platformMediaUrls.length,
      trialReel: override.trialReel,
    });

    let result: PublishResult;
    try {
      const execution = await publishPlatformTargets([
        {
          platform,
          content: override.caption || post.content,
          mediaUrl: platformMediaUrl,
          mediaUrls: platformMediaUrls,
          mediaType: getMediaType(post.contentType, platformMediaUrl ?? null, instagramContentType),
          instagramContentType,
          platformFormat: override.format,
          firstComment: override.firstComment,
          collaborators: override.collaborators,
          trialReel: instagramContentType === "reel" ? override.trialReel : undefined,
        },
      ]);
      result = execution.outcomes[0];
    } catch (error) {
      result = {
        platform: platform.type,
        provider: platform.provider === "bird" ? "bird" : platform.provider === "direct" ? "direct" : "late",
        accountId: platform.accountId ?? null,
        success: false,
        classification: "provider_error",
        error: error instanceof Error ? error.message : String(error),
      } as PublishResult;
    }
    results.push(result);

    const stepEnd = new Date();
    steps.push({
      name: stepName,
      status: result.success
        ? "completed"
        : result.classification === "disabled" || result.classification === "duplicate"
          ? "skipped"
          : "failed",
      startedAt: stepStart.toISOString(),
      completedAt: stepEnd.toISOString(),
      durationMs: stepEnd.getTime() - stepStart.getTime(),
      output: result,
      error: result.classification === "disabled" ? undefined : result.error,
    });

    await db
      .update(postTargets)
      .set({
        status: result.success
          ? "published"
          : result.classification === "duplicate" || result.classification === "disabled"
            ? "skipped"
            : "failed",
        publishedUrl: result.postUrl ?? null,
        platformPostId: result.postId ?? null,
        error: result.classification === "disabled" ? null : result.error ?? null,
        publishedAt: result.success ? stepEnd : null,
      })
      .where(eq(postTargets.id, target.id));

    if (
      input.notifyUserId &&
      !result.success &&
      result.classification !== "disabled" &&
      result.classification !== "duplicate"
    ) {
      await sendNotificationEmail({
        userId: input.notifyUserId,
        workspaceId,
        type: "post_failure",
        data: {
          title: post.title ?? post.content.slice(0, 60),
          platform: platform.name,
          message: result.error ?? "Unknown publish error",
          href: `/dashboard/posts/${postId}`,
        },
        dedupeKey: `post_target:${target.id}:failed`,
      });
    }
  }

  const completedAt = new Date();
  const runStatus = resolvePublishResultsStatus(results);
  const hasActionableResults = results.some((result) => result.classification !== "disabled");
  const postStatus = hasActionableResults
    ? resolvePostStatusFromTargetResults(results)
    : post.scheduledAt && post.scheduledAt > completedAt
      ? "scheduled"
      : "draft";

  await db
    .update(pipelineRuns)
    .set({
      status: runStatus,
      steps,
      durationMs: completedAt.getTime() - now.getTime(),
      completedAt,
    })
    .where(eq(pipelineRuns.id, runId));

  await db
    .update(posts)
    .set({
      status: postStatus,
      publishedAt:
        postStatus === "published" || postStatus === "partial_failure" ? completedAt : null,
      updatedAt: completedAt,
    })
    .where(eq(posts.id, postId));

  for (let i = 0; i < results.length; i++) {
    if (results[i]?.success) {
      await trackUsage(workspaceId, "post_published", targets[i]?.platform.id, { postId });
    }
  }

  return { ok: true, runId, steps, runStatus, postStatus, targetCount: targets.length };
}

/**
 * Publishes posts whose status is "scheduled" and whose scheduledAt has passed.
 * Each post is claimed atomically (scheduled -> publishing) so overlapping sweeps
 * or multiple replicas never publish the same post twice.
 */
export async function processDueScheduledPosts(options: { now?: Date; limit?: number } = {}) {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 10;

  const due = db
    .select()
    .from(posts)
    .where(and(eq(posts.status, "scheduled"), lte(posts.scheduledAt, now)))
    .orderBy(asc(posts.scheduledAt))
    .limit(limit)
    .all();

  const summary: Array<{ postId: string; outcome: string }> = [];

  for (const post of due) {
    const claimed = db
      .update(posts)
      .set({ status: "publishing", updatedAt: new Date() })
      .where(and(eq(posts.id, post.id), eq(posts.status, "scheduled")))
      .run();
    if (claimed.changes === 0) continue;

    const workspaceId = post.workspaceId;
    if (!workspaceId) {
      await setPostStatus(post.id, "failed");
      summary.push({ postId: post.id, outcome: "workspace_unavailable" });
      continue;
    }

    try {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
      });
      if (!workspace || workspace.isArchived) {
        await setPostStatus(post.id, "failed");
        summary.push({ postId: post.id, outcome: "workspace_unavailable" });
        continue;
      }

      const latestApprovalRequest = await getLatestApprovalRequestForPost({
        workspaceId,
        postId: post.id,
      });
      const approvalGuard = shouldBlockPublishForApproval({
        approvalWorkflowMode: normalizeApprovalWorkflowMode(workspace.approvalWorkflowMode),
        approvalRequestStatus: latestApprovalRequest?.status,
      });
      if (approvalGuard.blocked) {
        // Leave it for a human: keep it out of the due queue until approved and re-scheduled.
        await setPostStatus(post.id, "draft");
        summary.push({ postId: post.id, outcome: "blocked_for_approval" });
        continue;
      }

      const members = db
        .select({ userId: workspaceMemberships.userId, role: workspaceMemberships.workspaceRole })
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspaceId))
        .all();
      const rolePriority = ["owner", "admin", "manager", "editor", "publisher"];
      const owner = [...members].sort(
        (a, b) =>
          (rolePriority.indexOf(a.role) + 1 || 99) - (rolePriority.indexOf(b.role) + 1 || 99)
      )[0];

      const result = await executePostPublish({
        post: { ...post, status: "publishing" },
        workspaceId,
        notifyUserId: owner?.userId ?? null,
        trigger: "cron",
      });
      if (!result.ok) {
        await setPostStatus(post.id, "failed");
        summary.push({ postId: post.id, outcome: result.error });
      } else {
        summary.push({ postId: post.id, outcome: result.postStatus });
      }
    } catch (error) {
      console.error(`[scheduler] due post ${post.id} failed:`, error);
      await setPostStatus(post.id, "failed");
      summary.push({ postId: post.id, outcome: "error" });
    }
  }

  return summary;
}

async function setPostStatus(postId: string, status: string) {
  await db.update(posts).set({ status, updatedAt: new Date() }).where(eq(posts.id, postId));
}

function getMediaType(
  contentType: string,
  mediaUrl: string | null,
  instagramContentType?: string
) {
  if (!mediaUrl) return undefined;
  if (instagramContentType === "reel") return "video" as const;
  return contentType === "video" || contentType === "avatar_video" ? ("video" as const) : ("image" as const);
}
