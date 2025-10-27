// Cache por utilizador para a listagem de miners (+ETag)
import crypto from "crypto";

const listCache = new Map(); // key: userId -> { bodyJson, etag, expiresAt }
const LIST_TTL_MS = 10_000; // 10s

function makeEtagFromJson(json) {
  const raw = JSON.stringify(json);
  const hash = crypto.createHash("sha1").update(raw).digest("base64");
  return `W/"${hash}"`;
}

export function getCachedList(userId) {
  return listCache.get(String(userId));
}

export function setCachedList(userId, bodyJson) {
  const etag = makeEtagFromJson(bodyJson);
  listCache.set(String(userId), {
    bodyJson,
    etag,
    expiresAt: Date.now() + LIST_TTL_MS,
  });
  return { etag };
}

export function invalidateUserList(userId) {
  listCache.delete(String(userId));
}
