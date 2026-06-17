/**
 * 외부 이미지 URL → File 변환 (콘텐츠 스크립트 전용 공유 헬퍼).
 *
 * ads.naver.com 콘텐츠 스크립트에서 외부 CDN(shop-phinf/shopping-phinf.pstatic.net)에 직접
 * fetch하면 CORS에 막힌다. background가 host_permissions 기반으로 binary를 fetch해
 * base64로 돌려주면 여기서 File로 만든다. F-AssetBulk(파워링크 일괄등록)와
 * F-ShoppingImage(쇼핑 소재 대표 이미지 불러오기)가 같이 사용.
 */

import type { FetchImageBinaryResponse } from "@/types/messages";

/**
 * 이미지 URL을 background에 위임해 binary 받은 뒤 File로 변환.
 *
 * 응답 헤더의 content-type이 비정상(`application/octet-stream` 등)으로 와도 페이지 모달은
 * mime이 image/*가 아니면 reject — URL path 확장자 기반으로 mime을 자체 추정해 안전하게.
 */
export async function fetchUrlAsFile(url: string): Promise<File> {
  const resp = (await chrome.runtime.sendMessage({
    type: "FETCH_IMAGE_BINARY",
    url,
  })) as FetchImageBinaryResponse;
  if (!resp?.ok || !resp.base64) {
    throw new Error(resp?.error ?? "이미지를 받아오지 못했어요");
  }
  const ext = guessExtFromUrl(url);
  const headerMime = resp.mimeType ?? "";
  const mime =
    headerMime.startsWith("image/") && headerMime !== "image/octet-stream"
      ? headerMime
      : extToMime(ext);
  const name = guessFileName(url, mime);
  const buffer = base64ToBuffer(resp.base64);
  return new File([buffer], name, { type: mime });
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

function guessExtFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    const m = last.match(/\.([a-z0-9]+)$/i);
    return m?.[1]?.toLowerCase() ?? "jpg";
  } catch {
    return "jpg";
  }
}

function extToMime(ext: string): string {
  if (ext === "png") return "image/png";
  if (ext === "bmp") return "image/bmp";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

function guessFileName(url: string, mime: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    if (last && /\.[a-z0-9]+$/i.test(last)) return last;
    const ext = mimeToExt(mime);
    return last ? `${last}.${ext}` : `image.${ext}`;
  } catch {
    return `image.${mimeToExt(mime)}`;
  }
}

function mimeToExt(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("bmp")) return "bmp";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  return "jpg";
}
