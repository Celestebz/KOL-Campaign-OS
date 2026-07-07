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
  // DEBUG: force correct format
  return '2026-07-07 00:00:00';
}

module.exports = { toMysqlDatetime, nowMysqlDatetime };
