const path = require("node:path");

const { ROOT } = require("./config");
const { pathExists, readJson, writeJson } = require("./fsx");

const SETUP_STATE_PATH = path.join(ROOT, "docs", "ACTIVE", "SETUP_STATE.json");

function withDefaults(state = {}) {
  return {
    ...state,
    mode: state.mode || "test",
    health_status: state.health_status || "degraded",
    blockers: Array.isArray(state.blockers) ? state.blockers : [],
    last_doctor_run: state.last_doctor_run || null,
    last_doctor_result_path: state.last_doctor_result_path || null,
  };
}

async function loadSetupState(statePath = SETUP_STATE_PATH) {
  const exists = await pathExists(statePath);
  if (!exists) return withDefaults({});
  const raw = await readJson(statePath);
  return withDefaults(raw);
}

async function saveSetupState(next, statePath = SETUP_STATE_PATH) {
  await writeJson(statePath, withDefaults(next || {}));
}

async function updateSetupState(patch, statePath = SETUP_STATE_PATH) {
  const current = await loadSetupState(statePath);
  const next = withDefaults({
    ...current,
    ...(patch || {}),
  });
  await saveSetupState(next, statePath);
  return next;
}

module.exports = {
  SETUP_STATE_PATH,
  loadSetupState,
  saveSetupState,
  updateSetupState,
  withDefaults,
};
