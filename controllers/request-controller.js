const addRequest = (req, res, sim) => {
  try {
    const body = req.body || {};

    // Basic validation
    if (!body.origin || !body.destination) {
      return res.status(400).json({
        ok: false,
        error: "Both 'origin' and 'destination' must be provided.",
      });
    }

    if (body.origin === body.destination) {
      return res.status(400).json({
        ok: false,
        error: "Origin and destination cannot be the same floor.",
      });
    }

    if (
      typeof body.origin !== "number" ||
      typeof body.destination !== "number" ||
      body.origin < 1 ||
      body.destination < 1 ||
      body.origin > sim.config.nFloors ||
      body.destination > sim.config.nFloors
    ) {
      return res.status(400).json({
        ok: false,
        error: `Origin and destination must be numbers between 1 and ${sim.config.nFloors}.`,
      });
    }

    // Try adding request to simulation
    const result = sim.addManualRequest(body);

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.message });
    }

    return res.json({
      ok: true,
      message: result.message,
      request: result.request,
    });
  } catch (err) {
    console.error("Error in addRequest:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to add request: " + (err.message || err),
    });
  }
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
