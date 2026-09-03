const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function runWithUser(user, callback) {
  return storage.run({ userId: Number(user.id) }, callback);
}

function currentUserId() {
  const userId = Number(storage.getStore()?.userId);
  return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
}

function requireCurrentUserId() {
  const userId = currentUserId();
  if (!userId) throw Object.assign(new Error('当前操作缺少用户上下文'), { status: 401 });
  return userId;
}

module.exports = { runWithUser, currentUserId, requireCurrentUserId };
