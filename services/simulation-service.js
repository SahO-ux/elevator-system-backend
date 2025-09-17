import { createSimClock } from "../lib/sim-clock.js";
import { createElevator } from "../models/elevator-model.js";
import { createScheduler } from "./scheduler-service.js";
import { v4 as uuidv4 } from "uuid";

let _wss = null;

export function initSimulationService(wss) {
  _wss = wss;

  wss.on("connection", (ws) => {
    // send initial snapshot to newly connected client (non-fatal)
    try {
      ws.send(JSON.stringify({ type: "snapshot", data: sim.snapshot() }));
    } catch (e) {}

    ws.on("message", (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.cmd === "start") sim.start();
        if (data.cmd === "stop") sim.stop();
        if (data.cmd === "reset") sim.reset();
        if (data.cmd === "speed") sim.setSpeed(Number(data.speed) || 1);
        if (data.cmd === "manualRequest")
          sim.addManualRequest(data.payload || {});
        if (data.cmd === "scenario") sim.spawnScenario(data.name);

        // NEW: reconfig command (safe: only when stopped)
        if (data.cmd === "reconfig") {
          const cfg = data.config || {};
          if (sim.running) {
            // can't reconfigure while running — reply to client
            ws.send(
              JSON.stringify({
                type: "error",
                message: "Stop the simulation before applying configuration.",
              })
            );
          } else {
            try {
              // apply config and re-init simulation state with new values
              sim.init(cfg);
              if (cfg.requestFreq > 0) {
                sim.setRequestFrequency(cfg.requestFreq);
              }
              sim.broadcast();
              ws.send(
                JSON.stringify({
                  type: "info",
                  message: "Configuration applied.",
                })
              );
            } catch (e) {
              console.error("Reconfig error:", e);
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "Failed to apply configuration: " + (e.message || e),
                })
              );
            }
          }
        }
      } catch (e) {
        console.error(`Error in function initSimulationService: ${e}`);
      }
    });
  });
}

const defaultConfig = {
  nElevators: 3,
  nFloors: 12,
  // highTrafficFloors: [3, 6],
  timePerFloor: 1000,
  doorDwell: 2000,
  lobbyFloor: 1,
};

const sim = {
  clock: createSimClock(),
  config: { ...defaultConfig },
  elevators: [],
  pendingRequests: [],
  servedRequests: [],
  running: false,
  speed: 1,
  tickIntervalHandle: null,
  scheduler: null,
  requestFreq: 0, // requests per minute
  requestSpawner: null, // interval handle

  init(config = {}) {
    this.config = { ...this.config, ...config };
    this.elevators = [];
    for (let i = 0; i < this.config.nElevators; i++) {
      const e = createElevator(i + 1, 1, 6);
      // initialize statusSince in sim-time (not real Date.now())
      e.statusSince = this.clock.now();
      this.elevators.push(e);
      // this.elevators.push(createElevator(i + 1, 1, 6));
    }

    //All Elevators have n (12) floors
    this.elevators.forEach((e) => (e.buildingFloors = this.config.nFloors));
    this.pendingRequests = [];
    this.servedRequests = [];
    this.scheduler = createScheduler(this);
  },

  start() {
    if (this.running) return;

    // ensure sim is initialized
    if (!this.scheduler) this.init();

    this.running = true;
    const tickRate = 200;
    this.tickIntervalHandle = setInterval(() => this._tick(200), tickRate); // rate limiting

    // start spawner if freq set
    if (this.requestFreq > 0) {
      this.setRequestFrequency(this.requestFreq);
    }
  },

  stop() {
    if (!this.running) return;
    clearInterval(this.tickIntervalHandle);
    this.tickIntervalHandle = null;
    this.running = false;

    if (this.requestSpawner) {
      clearInterval(this.requestSpawner);
      this.requestSpawner = null;
    }
  },

  reset() {
    this.stop();
    this.clock = createSimClock();
    this.init();
    this.broadcast();
  },

  setSpeed(s) {
    this.speed = s;
    this.clock.setSpeed(s);
    this.speed = s;
  },

  snapshot() {
    return {
      time: this.clock.now(),
      elevators: this.elevators.map((e) => ({ ...e })),
      pendingRequests: this.pendingRequests.map((r) => ({ ...r })),
    };
  },

  metricsSnapshot() {
    const served = this.servedRequests;
    const avgWait = served.length
      ? served.reduce(
          (a, b) => a + ((b.pickupTime || b.servedAt) - b.timestamp),
          0
        ) / served.length
      : 0;
    const avgTravel = served.length
      ? served.reduce(
          (a, b) =>
            a +
            ((b.dropoffTime || b.completedAt) - (b.pickupTime || b.servedAt)),
          0
        ) / served.length
      : 0;
    const util = this.elevators.length
      ? this.elevators.reduce((a, e) => a + (e.utilTime || 0), 0) /
        (this.elevators.length * (this.clock.now() || 1))
      : 0;
    return {
      servedCount: served.length,
      avgWait,
      avgTravel,
      utilization: util,
    };
  },

  addManualRequest({ type = "external", origin = 1, destination = 2 } = {}) {
    const r = {
      id: uuidv4(),
      timestamp: this.clock.now(),
      type,
      origin,
      destination,
      basePriority: 1,
      priority: 1,
    };
    this.pendingRequests.push(r);
  },

  /**
   * Set request spawn frequency (requests per minute).
   * Spawns uniformly-random external requests while the sim is running.
   * NOTE: morning-rush is NOT applied here — use the "Morning Rush" scenario/button instead.
   */
  setRequestFrequency(freqPerMinute = 0) {
    // store setting
    this.requestFreq = Number(freqPerMinute) || 0;

    // clear any existing spawner
    if (this.requestSpawner) {
      clearInterval(this.requestSpawner);
      this.requestSpawner = null;
    }

    // don't start spawner unless simulation is running and freq > 0
    if (!this.running || this.requestFreq <= 0) return;

    // compute ms interval between spawns (min 200ms)
    const intervalMs = Math.max(200, Math.floor(60_000 / this.requestFreq));

    // create spawner
    this.requestSpawner = setInterval(() => {
      try {
        // Uniform random request: pick origin and destination distinct uniformly
        let origin = Math.floor(Math.random() * this.config.nFloors) + 1;
        let destination;
        do {
          destination = Math.floor(Math.random() * this.config.nFloors) + 1;
        } while (destination === origin);

        // push as an external manual request (will be scheduled by scheduler)
        this.addManualRequest({
          type: "external",
          origin,
          destination,
        });
      } catch (err) {
        // keep spawner alive; log for debug
        console.warn("[sim] requestSpawner error", err);
      }
    }, intervalMs);
  },

  spawnScenario(name, _count = null) {
    const count =
      typeof _count === "number"
        ? _count
        : name === "morningRush"
        ? 50
        : name === "randomBurst"
        ? 100
        : 10;

    const pickRandomFloorExcept = (excludeFloor) => {
      if (this.config.nFloors <= 1) return excludeFloor; // degenerate
      let f;
      do {
        f = Math.floor(Math.random() * this.config.nFloors) + 1;
      } while (f === excludeFloor);
      return f;
    };

    if (name === "morningRush") {
      // Morning Rush: majority from lobby to upper floors.
      for (let i = 0; i < count; i++) {
        // For clarity: choose destination uniformly among floors != lobbyFloor,
        // but prefer upper floors if possible by retrying until destination > lobbyFloor.
        const origin = this.config.lobbyFloor || 1;
        let destination = pickRandomFloorExcept(origin);

        // If building has floors above the lobby, bias to upper floors (try up to a few times)
        if (this.config.nFloors > origin) {
          let tries = 0;
          while (destination <= origin && tries < 6) {
            destination =
              Math.floor(Math.random() * (this.config.nFloors - origin)) +
              origin +
              1;
            tries++;
          }
          // fallback already guaranteed to be != origin
        }

        // Use addManualRequest to ensure consistent id/timestamp/defaults
        this.addManualRequest({
          type: "external",
          origin,
          destination,
          basePriority: 1,
          priority: 1,
        });
      }
    } else if (name === "randomBurst") {
      for (let i = 0; i < count; i++) {
        const origin = Math.floor(Math.random() * this.config.nFloors) + 1;
        const destination = pickRandomFloorExcept(origin);

        this.addManualRequest({
          type: "external",
          origin,
          destination,
          basePriority: 1,
          priority: 1,
        });
      }
    } else {
      // generic named scenario fallback: spawn `count` uniformly random requests
      for (let i = 0; i < count; i++) {
        const origin = Math.floor(Math.random() * this.config.nFloors) + 1;
        const destination = pickRandomFloorExcept(origin);
        this.addManualRequest({ type: "external", origin, destination });
      }
    }
  },

  _isMorningRushWindow() {
    const dayMs = 24 * 60 * 60 * 1000;
    const simDayTime = this.clock.now() % dayMs;
    const nineAm = 9 * 60 * 60 * 1000;
    const nineThirty = nineAm + 30 * 60 * 1000;
    return simDayTime >= nineAm && simDayTime <= nineThirty;
  },

  _processElevatorMovement(e, dt) {
    e._accTime = e._accTime || 0;

    if (
      e.doorState === "open" &&
      this.clock.now() - (e.statusSince || 0) < this.config.doorDwell
    ) {
      return;
    }

    if (e.doorState === "open") {
      e.doorState = "closed";
      e.statusSince = this.clock.now();
    }

    if (!e.targetFloors || e.targetFloors.length === 0) {
      // mark idle start in sim-time
      if (e.direction !== "idle") {
        e.direction = "idle";
        e.statusSince = this.clock.now();
      } else {
        // if already idle, ensure statusSince is set (defensive)
        e.statusSince = e.statusSince || this.clock.now();
      }
      return;
      // e.direction = "idle";
      // return;
    }

    const target = e.targetFloors[0];
    if (e.currentFloor === target) {
      e.doorState = "open";
      e.statusSince = this.clock.now();

      for (const r of this.pendingRequests.slice()) {
        if (
          r.assignedTo === e.id &&
          r.origin === e.currentFloor &&
          !r.pickupTime
        ) {
          r.pickupTime = this.clock.now();
          e.passengerCount += 1;

          // Ensure the dropoff destination is scheduled (in case assignment timing missed it)
          if (
            r.destination != null &&
            !e.targetFloors.includes(r.destination)
          ) {
            e.targetFloors.push(r.destination);
          }
        }

        // DROPOFF: passenger leaving
        if (
          r.assignedTo === e.id &&
          r.destination === e.currentFloor &&
          r.pickupTime &&
          !r.dropoffTime
        ) {
          r.dropoffTime = this.clock.now();
          e.passengerCount = Math.max(0, e.passengerCount - 1);
          this.servedRequests.push(r);
          this.pendingRequests = this.pendingRequests.filter(
            (x) => x.id !== r.id
          );
        }
      }

      e.targetFloors.shift();
      return;
      // remove this target
      // const arrivedFloor = e.currentFloor;
      // e.targetFloors.shift();

      // // If this was a rebalancer target, clear marker and set last rebalance time
      // if (e._rebalanceTarget && e._rebalanceTarget === arrivedFloor) {
      //   // Why: ensures elevator doesn't get immediately re-targeted to other HF
      //   // and records when rebalance finished (for cooldown).
      //   e._rebalanceTarget = null;
      //   e._lastRebalanceTime = this.clock.now();
      //   // debug
      //   console.log(
      //     `[rebalancer] elevator ${e.id} reached rebalance floor ${arrivedFloor}`
      //   );
      // }
      // return;
    } else {
      const timePerFloor = this.config.timePerFloor; // sim-ms needed to move one floor

      // accumulate sim dt into elevator accumulator
      e._accTime += dt;

      // const floorsToMove = Math.floor(dt / timePerFloor); // Old
      const floorsToMove = Math.floor(e._accTime / timePerFloor);
      if (floorsToMove <= 0) {
        e.direction = e.currentFloor < target ? "up" : "down";
        return;
      }
      for (let i = 0; i < floorsToMove; i++) {
        if (e.currentFloor < target) {
          e.currentFloor++;
          e.direction = "up";
        } else if (e.currentFloor > target) {
          e.currentFloor--;
          e.direction = "down";
        }
        // ADDED if reached target early, break
        if (e.currentFloor === target) break;
      }
      //ADDED 2 line below
      // subtract consumed time from accumulator
      e._accTime = e._accTime % timePerFloor; // keep only leftover < timePerFloor

      e.statusSince = this.clock.now();
    }
  },

  _tick(realDt) {
    this.clock.advance(realDt);
    const simDt = realDt * this.clock.speed;

    for (const e of this.elevators) this._processElevatorMovement(e, simDt);

    try {
      // TBD:- CLEANUP PENDING, REMOVE IF CONDs
      if (this.scheduler && typeof this.scheduler.assign === "function") {
        this.scheduler.assign(); // Call the callback function
      }
      // this.scheduler.assign();
    } catch (err) {
      console.error(`Error in function _tick: ${err}`);
    }

    for (const e of this.elevators) {
      e.utilTime = (e.utilTime || 0) + (e.passengerCount > 0 ? simDt : 0);
    }

    this.broadcast(); // Send to FE
  },

  broadcast() {
    const payload = JSON.stringify({ type: "snapshot", data: this.snapshot() });
    if (!_wss) return;
    _wss.clients.forEach((c) => {
      // Here readyState = 1, indicates that connection is opne
      // & ready for comms
      // if (c.readyState === 1) console.log({ payload });
      if (c.readyState === 1) c.send(payload);
    });
  },
};

export function getSimulationService() {
  return sim;
}
export default sim;
