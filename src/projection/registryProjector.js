function emptyRegistry() {
  return { version: 1, cases: [] };
}

function applyEvent(state, event) {
  const { type, payload } = event;
  if (!type) return state;

  switch (type) {

    case "CASE_CREATED":
      if (!state.cases.find(c => c.case_id === payload.case_id)) {
        state.cases.push({
          case_id: payload.case_id,
          title: payload.title,
          aliases: payload.aliases || [],
          tags: payload.tags || [],
          status: "active",
          created_at: event.ts,
          updated_at: event.ts
        });
      }
      break;

    case "CASE_UPDATED":
      state.cases = state.cases.map(c =>
        c.case_id === payload.case_id
          ? { ...c, ...payload, updated_at: event.ts }
          : c
      );
      break;

    case "CASE_STATUS_CHANGED":
      state.cases = state.cases.map(c =>
        c.case_id === payload.case_id
          ? { ...c, status: payload.status, updated_at: event.ts }
          : c
      );
      break;

    case "CASE_MERGED":
      state.cases = state.cases.filter(c => c.case_id !== payload.from);
      break;

    case "CASE_ARCHIVED":
      state.cases = state.cases.map(c =>
        c.case_id === payload.case_id
          ? { ...c, status: "archived", updated_at: event.ts }
          : c
      );
      break;

    default:
      break;
  }

  return state;
}

function rebuildRegistryFromEvents(events) {
  let state = emptyRegistry();
  for (const event of events) {
    state = applyEvent(state, event);
  }
  return state;
}

module.exports = {
  emptyRegistry,
  applyEvent,
  rebuildRegistryFromEvents
};
