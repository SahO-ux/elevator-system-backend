import controlController from "./controllers/control-controller.js";
import requestController from "./controllers/request-controller.js";

// Routes specified for debugging / testing purposes
// Currently only metrics api is used by frontend for getting
// periodical simulation metrics data

export default function createApp(app, simService) {
  app.post("/api/control/start", (req, res) =>
    controlController.start(req, res, simService)
  );
  app.post("/api/control/stop", (req, res) =>
    controlController.stop(req, res, simService)
  );
  app.post("/api/control/reset", (req, res) =>
    controlController.reset(req, res, simService)
  );
  app.post("/api/control/speed", (req, res) =>
    controlController.speed(req, res, simService)
  );

  app.post("/api/requests", (req, res) =>
    requestController.addRequest(req, res, simService)
  );
  app.post("/api/scenario", (req, res) =>
    requestController.spawnScenario(req, res, simService)
  );

  app.get("/api/state", (req, res) => res.json(simService.snapshot()));
  app.get("/api/metrics", (req, res) => res.json(simService.metricsSnapshot()));
}
