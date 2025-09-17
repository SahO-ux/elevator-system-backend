const start = (req, res, sim) => {
  sim.start();
  res.json({ ok: true });
};
const stop = (req, res, sim) => {
  sim.stop();
  res.json({ ok: true });
};
const reset = (req, res, sim) => {
  sim.reset();
  res.json({ ok: true });
};

const speed = (req, res, sim) => {
  const { speed } = req.body;
  sim.setSpeed(Number(speed) || 1);
  res.json({ ok: true, speed: sim.speed });
};

export default {
  start,
  stop,
  reset,
  speed,
};
