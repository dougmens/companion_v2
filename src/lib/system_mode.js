const { runSystemDoctor } = require("./system_doctor");
const { updateSetupState } = require("./setup_state");

const ALLOWED_MODES = new Set(["test", "staged", "production"]);

async function setSystemMode({ mode }) {
  const m = String(mode || "").trim().toLowerCase();
  if (!ALLOWED_MODES.has(m)) {
    throw new Error(`Invalid mode: ${mode}. Allowed: test|staged|production`);
  }
  if (m === "production") {
    throw new Error("Direct mode switch to production is disabled. Use `system:promote`.");
  }

  const next = await updateSetupState({
    mode: m,
    health_status: m === "test" ? "degraded" : "stable",
    blockers: m === "test" ? ["manual_mode_set"] : [],
  });

  return {
    ok: true,
    mode: next.mode,
    health_status: next.health_status,
    blockers: next.blockers || [],
  };
}

async function promoteSystem() {
  const doctor = await runSystemDoctor({
    strict: true,
    runTests: true,
    writeProbe: false,
  });

  if (!doctor.readiness) {
    const next = await updateSetupState({
      mode: "staged",
      health_status: "blocked",
      blockers: doctor.blockers || [],
    });
    return {
      ok: false,
      mode: next.mode,
      health_status: next.health_status,
      blockers: next.blockers || [],
      doctor,
      exit_code: 1,
    };
  }

  const next = await updateSetupState({
    mode: "production",
    health_status: "stable",
    blockers: [],
  });
  return {
    ok: true,
    mode: next.mode,
    health_status: next.health_status,
    blockers: [],
    doctor,
    exit_code: 0,
  };
}

module.exports = {
  promoteSystem,
  setSystemMode,
};
