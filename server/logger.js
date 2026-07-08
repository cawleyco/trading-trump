// Structured JSON-lines logging to stdout; the SQLite tables are the durable
// audit trail, this is the operational log.

function emit(level, component, message, extra) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component,
    message,
    ...(extra || {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  info: (component, message, extra) => emit('info', component, message, extra),
  warn: (component, message, extra) => emit('warn', component, message, extra),
  error: (component, message, extra) => emit('error', component, message, extra),
};
