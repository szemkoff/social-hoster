const VIDEO_EXTENSION = /\.(mp4|mov|m4v|webm)(\?|#|$)/i;

/** True when a media URL points at a video file, judged by its extension. */
export function isVideoMediaUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && VIDEO_EXTENSION.test(url);
}

/**
 * Video src for thumbnails. The `#t=` fragment makes browsers seek to the
 * first frame, so a paused <video> shows a picture instead of a blank box.
 */
export function videoThumbnailSrc(url: string): string {
  return url.includes("#") ? url : `${url}#t=0.1`;
}
