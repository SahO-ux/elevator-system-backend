import express from "express";
import http from "http";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";
import morgan from "morgan";
import cors from "cors";
import dotenv from "dotenv";

import createApp from "./app.js";
import {
  initSimulationService,
  getSimulationService,
} from "./services/simulation-service.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.use(morgan("common"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

initSimulationService(wss);
createApp(app, getSimulationService());

// Test route
app.get("/", (req, res) => res.json("Hello"));

const startServer = async () => {
  const PORT = process.env.PORT || 4000;

  server.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
  });
};
startServer();
