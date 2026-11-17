import { db } from "@/db";
import { posts } from "@/db/schema";
import { requireApiWorkspacePublisher } from "@/lib/api-authorization";
import { getLatestApprovalRequestForPost } from "@/lib/approval-requests";
import { normalizeApprovalWorkflowMode, shouldBlockPublishForApproval } from "@/lib/approvals";
import { recordTenantAuditEvent } from "@/lib/audit";
import { executePostPublish } from "@/lib/publish/publish-post";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const tenant = await requireApiWorkspacePublisher();
  if (tenant instanceof NextResponse) return tenant;

  const { id: postId } = await params;
  const post = await db.query.posts.findFirst({
    where: and(eq(posts.id, postId), eq(posts.workspaceId, tenant.currentWorkspace.id)),
  });
  if (!post) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }

  const latestApprovalRequest = await getLatestApprovalRequestForPost({
    workspaceId: tenant.currentWorkspace.id,
    postId,
  });
  const approvalGuard = shouldBlockPublishForApproval({
    approvalWorkflowMode: normalizeApprovalWorkflowMode(
      tenant.currentWorkspace.approvalWorkflowMode
    ),
    approvalRequestStatus: latestApprovalRequest?.status,
  });

  if (approvalGuard.blocked) {
    await recordTenantAuditEvent(tenant, {
      action: "post.publish.blocked",
      targetType: "post",
      targetId: postId,
      metadata: {
        status: "blocked",
        endpoint: `POST /api/posts/${postId}/publish`,
        href: `/dashboard/posts/${postId}`,
        approvalState: approvalGuard.approvalState,
        reason: approvalGuard.reason,
      },
    });

    return NextResponse.json(
      {
        error: approvalGuard.reason ?? "Approval required before publish.",
        approvalState: approvalGuard.approvalState,
      },
      { status: 409 }
    );
  }

  const execution = await executePostPublish({
    post,
    workspaceId: tenant.currentWorkspace.id,
    notifyUserId: tenant.user.id,
    trigger: "api",
  });

  if (!execution.ok) {
    return NextResponse.json({ error: execution.error }, { status: execution.status });
  }

  const { runId, steps, runStatus, postStatus, targetCount } = execution;

  // Cancel "first post" drip if this was a successful publish
  if (postStatus === "published" || postStatus === "partial_failure") {
    try {
      const { cancelDripIfDone } = await import("@/lib/marketing/drip");
      cancelDripIfDone(tenant.user.id, "welcome_3_first_post");
    } catch { /* non-critical */ }
  }

  await recordTenantAuditEvent(tenant, {
    action: "post.publish",
    targetType: "post",
    targetId: postId,
    metadata: {
      status: postStatus,
      endpoint: `POST /api/posts/${postId}/publish`,
      runId,
      platformTargetCount: targetCount,
    },
  });

  return NextResponse.json({
    runId,
    steps,
    success: runStatus === "completed",
    postStatus,
  });
}
