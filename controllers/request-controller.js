const addRequest = (req, res, sim) => {
  const body = req.body || {};
  sim.addManualRequest(body);
  res.json({ ok: true });
};

const spawnScenario = (req, res, sim) => {
  const { name, count } = req.body;

  // validate scenario name
  if (!["morningRush", "randomBurst"].includes(name)) {
    return res.status(400).json({
      ok: false,
      error: `Invalid scenario name "${name}". Allowed: morningRush, randomBurst.`,
    });
  }

  if (count > 250) {
    return res.status(400).json({
      ok: false,
      error: `Count too large "${count}". Max allowed is 200.`,
    });
  }

  try {
    sim.spawnScenario(name, count);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Error spawning scenario:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to spawn scenario: " + (err.message || err),
    });
  }
};

export default {
  addRequest,
  spawnScenario,
};
