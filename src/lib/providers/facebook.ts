import { APIError, PublishError } from "./errors";
import { OAuthProvider } from "./oauth";
import { buildAuthUrl } from "./oauth";
import type {
  AccountProfile,
  MediaType,
  OAuthTokens,
  PostType,
  PublishContent,
  PublishResult,
  RateLimitConfig,
} from "./types";

const BASE_URL = "https://graph.facebook.com/v21.0";
const OAUTH_URL = "https://www.facebook.com/v21.0/dialog/oauth";
const TOKEN_URL = `${BASE_URL}/oauth/access_token`;

type FacebookPage = {
  id: string;
  name: string;
  accessToken: string;
  category: string;
  picture?: string;
};

export class FacebookProvider extends OAuthProvider {
  platformName = "Facebook";
  authType = "oauth2" as const;
  maxCaptionLength = 63_206;
  supportedPostTypes: PostType[] = ["text", "image", "video", "link"];
  supportedMediaTypes: MediaType[] = ["jpeg", "png", "gif", "mp4", "mov"];
  requiredScopes = [
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_posts",
    ...extraFacebookScopes(),
  ];

  get rateLimits(): RateLimitConfig {
    return {
      requestsPerHour: 200,
      requestsPerDay: 4800,
      publishPerDay: 4800,
      extra: { postsPer24hPerPage: 4800 },
    };
  }

  getAuthUrl(redirectUri: string, state: string) {
    return buildAuthUrl(OAUTH_URL, {
      client_id: this.clientId(),
      redirect_uri: redirectUri,
      state,
      scope: this.requiredScopes.join(","),
      response_type: "code",
      // Re-show the permission and Page picker, even if the user granted the
      // app before. Without this, Facebook silently reuses the earlier Page
      // selection and new Pages can never be added.
      auth_type: "rerequest",
    });
  }

  async exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens> {
    const body = await this.requestJson<Record<string, unknown>>("POST", TOKEN_URL, {
      params: {
        code,
        redirect_uri: redirectUri,
        client_id: this.clientId(),
        client_secret: this.clientSecret(),
      },
    });
    return this.tokenToResult(body);
  }

  async refreshToken(shortLivedToken: string): Promise<OAuthTokens> {
    const body = await this.requestJson<Record<string, unknown>>("GET", TOKEN_URL, {
      params: {
        grant_type: "fb_exchange_token",
        client_id: this.clientId(),
        client_secret: this.clientSecret(),
        fb_exchange_token: shortLivedToken,
      },
    });
    return this.tokenToResult(body);
  }

  async getProfile(accessToken: string): Promise<AccountProfile> {
    const body = await this.requestJson<Record<string, unknown>>(
      "GET",
      `${BASE_URL}/me`,
      {
        accessToken,
        params: { fields: "id,name,picture" },
      }
    );
    const picture = recordValue(recordValue(body.picture).data);

    return {
      platformId: stringValue(body.id),
      name: stringValue(body.name),
      avatarUrl: optionalString(picture.url),
      extra: body,
    };
  }

  async getUserPages(accessToken: string): Promise<FacebookPage[]> {
    const first = await this.requestJson<Record<string, unknown>>(
      "GET",
      `${BASE_URL}/me/accounts`,
      {
        accessToken,
        params: { fields: PAGE_FIELDS, limit: "100" },
      }
    );
    if (first.error) {
      throw new APIError("Failed to fetch Facebook pages", {
        platform: this.platformName,
        rawResponse: first,
      });
    }

    const byId = new Map<string, FacebookPage>();
    const add = (items: unknown[]) => {
      for (const item of items) {
        const page = toFacebookPage(item);
        if (page.id && page.accessToken && !byId.has(page.id)) {
          byId.set(page.id, page);
        }
      }
    };

    add(await this.collectPages(first));

    // Pages owned by a Business portfolio are not always listed under
    // /me/accounts. When business_management is granted, also read the
    // portfolio's owned and client Pages. Errors here are non-fatal.
    try {
      const businesses = await this.requestJson<Record<string, unknown>>(
        "GET",
        `${BASE_URL}/me/businesses`,
        { accessToken, params: { fields: "id,name", limit: "100" } }
      );
      const list = Array.isArray(businesses.data) ? businesses.data : [];
      for (const biz of list) {
        const bizId = stringValue(recordValue(biz).id);
        if (!bizId) continue;
        for (const edge of ["owned_pages", "client_pages"]) {
          try {
            const body = await this.requestJson<Record<string, unknown>>(
              "GET",
              `${BASE_URL}/${bizId}/${edge}`,
              { accessToken, params: { fields: PAGE_FIELDS, limit: "100" } }
            );
            if (!body.error) add(await this.collectPages(body));
          } catch {
            /* non-critical */
          }
        }
      }
    } catch {
      /* business_management not granted */
    }

    return [...byId.values()];
  }

  private async collectPages(body: Record<string, unknown>) {
    const items: unknown[] = Array.isArray(body.data) ? [...body.data] : [];
    let next = optionalString(recordValue(body.paging).next);
    for (let i = 0; next && i < 10; i += 1) {
      try {
        const res = await fetch(next);
        const page = (await res.json()) as Record<string, unknown>;
        if (Array.isArray(page.data)) items.push(...page.data);
        next = optionalString(recordValue(page.paging).next);
      } catch {
        break;
      }
    }
    return items;
  }

  async publishPost(
    accessToken: string,
    content: PublishContent
  ): Promise<PublishResult> {
    const pageId = extraString(content, "page_id", "pageId");
    if (!pageId) {
      throw new PublishError(
        "page_id is required in content.extra for Facebook publishing",
        { platform: this.platformName }
      );
    }

    const mediaUrls = content.mediaUrls ?? [];
    // The publisher labels any multi-image post "carousel"; on Facebook that
    // becomes a multi-photo post. Videos inside a carousel are not supported
    // here, so only image URLs are attached.
    const isPhotoPost = content.postType === "image" || content.postType === "carousel";
    if (isPhotoPost && mediaUrls.length > 1) {
      return this.publishPhotos(accessToken, pageId, content, mediaUrls);
    }
    if (isPhotoPost && mediaUrls.length > 0) {
      return this.publishPhoto(accessToken, pageId, content, mediaUrls[0]);
    }
    if (content.postType === "video" && mediaUrls.length > 0) {
      return this.publishVideo(accessToken, pageId, content, mediaUrls[0]);
    }
    return this.publishTextOrLink(accessToken, pageId, content);
  }

  private async publishTextOrLink(
    accessToken: string,
    pageId: string,
    content: PublishContent
  ): Promise<PublishResult> {
    const payload: Record<string, string> = { message: content.text };
    if (content.linkUrl) payload.link = content.linkUrl;

    const body = await this.requestJson<Record<string, unknown>>(
      "POST",
      `${BASE_URL}/${pageId}/feed`,
      { accessToken, json: payload }
    );
    const id = stringValue(body.id);
    return {
      platformPostId: id,
      url: id ? `https://www.facebook.com/${id}` : undefined,
      extra: body,
    };
  }

  // Multi-photo post: upload each image unpublished, then attach all of
  // them to a single feed post (Facebook's equivalent of a carousel).
  private async publishPhotos(
    accessToken: string,
    pageId: string,
    content: PublishContent,
    mediaUrls: string[]
  ): Promise<PublishResult> {
    const mediaIds: string[] = [];
    for (const url of mediaUrls.slice(0, 10)) {
      const photo = await this.requestJson<Record<string, unknown>>(
        "POST",
        `${BASE_URL}/${pageId}/photos`,
        { accessToken, json: { url, published: false } }
      );
      const id = stringValue(photo.id);
      if (!id) {
        throw new PublishError("Facebook did not return an id for an uploaded photo", {
          platform: this.platformName,
        });
      }
      mediaIds.push(id);
    }

    const payload: Record<string, unknown> = {
      attached_media: mediaIds.map((id) => ({ media_fbid: id })),
    };
    if (content.text) payload.message = content.text;

    const body = await this.requestJson<Record<string, unknown>>(
      "POST",
      `${BASE_URL}/${pageId}/feed`,
      { accessToken, json: payload }
    );
    const postId = stringValue(body.id);
    return {
      platformPostId: postId,
      url: postId ? `https://www.facebook.com/${postId}` : undefined,
      extra: { ...body, mediaIds },
    };
  }

  private async publishPhoto(
    accessToken: string,
    pageId: string,
    content: PublishContent,
    mediaUrl: string
  ): Promise<PublishResult> {
    const payload: Record<string, string> = { url: mediaUrl };
    if (content.text) payload.message = content.text;

    const body = await this.requestJson<Record<string, unknown>>(
      "POST",
      `${BASE_URL}/${pageId}/photos`,
      { accessToken, json: payload }
    );
    const id = stringValue(body.id);
    const postId = stringValue(body.post_id) || id;
    return {
      platformPostId: id,
      url: postId ? `https://www.facebook.com/${postId}` : undefined,
      extra: body,
    };
  }

  private async publishVideo(
    accessToken: string,
    pageId: string,
    content: PublishContent,
    mediaUrl: string
  ): Promise<PublishResult> {
    const payload: Record<string, string> = { file_url: mediaUrl };
    if (content.text) payload.description = content.text;

    const body = await this.requestJson<Record<string, unknown>>(
      "POST",
      `${BASE_URL}/${pageId}/videos`,
      { accessToken, json: payload }
    );
    const id = stringValue(body.id);
    return {
      platformPostId: id,
      url: id ? `https://www.facebook.com/${id}` : undefined,
      extra: body,
    };
  }
}

const PAGE_FIELDS = "id,name,access_token,category,picture";

function toFacebookPage(item: unknown): FacebookPage {
  const page = recordValue(item);
  const picture = recordValue(recordValue(page.picture).data);
  return {
    id: stringValue(page.id),
    name: stringValue(page.name),
    accessToken: stringValue(page.access_token),
    category: stringValue(page.category),
    picture: optionalString(picture.url),
  };
}

function extraFacebookScopes() {
  return (process.env.FACEBOOK_EXTRA_SCOPES ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function extraString(content: PublishContent, ...keys: string[]) {
  const extra = recordValue(content.extra);
  for (const key of keys) {
    const value = optionalString(extra[key]);
    if (value) return value;
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

export default FacebookProvider;
