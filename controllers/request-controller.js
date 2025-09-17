const addRequest = (req, res, sim) => {
  const body = req.body || {};
  sim.addManualRequest(body);
  res.json({ ok: true });
};

const spawnScenario = (req, res, sim) => {
  const { name, count } = req.body;
  sim.spawnScenario(name, count);
  res.json({ ok: true });
};

export default {
  addRequest,
  spawnScenario,
};
