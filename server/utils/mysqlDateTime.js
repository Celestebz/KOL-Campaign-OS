function toMysqlDatetime(value) {
  if (value === undefined || value === null || value === '') return value;
  if (typeof value === 'number' || typeof value === 'string') {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toISOString().slice(0, 19).replace('T', ' ');
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }
  return value;
}

function nowMysqlDatetime() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// sequelize 的 injectReplacements 序列化 Date 时忽略 timezone 配置，会按 Node 进程
// 本地时区写库；而读取路径按 UTC 解析，导致前端显示晚 8 小时。这里在 dbOperations
// 入口统一把 Date 参数转成 UTC 墙钟字符串，与 NOW()/模型时间戳的存储口径一致。
// 只处理 Date 实例，字符串/数字参数原样透传。
function sanitizeBindParams(params) {
  const convert = (value) => (value instanceof Date ? toMysqlDatetime(value) : value);
  if (Array.isArray(params)) return params.map(convert);
  if (params && typeof params === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(params)) out[key] = convert(value);
    return out;
  }
  return params;
}

module.exports = { toMysqlDatetime, nowMysqlDatetime, sanitizeBindParams };
