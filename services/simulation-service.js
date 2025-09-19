import { v4 as uuidv4 } from "uuid";

import { createSimClock } from "../lib/sim-clock.js";
import { createElevator } from "../models/elevator-model.js";
import { createScheduler } from "./scheduler-service.js";
import { createHandlers, MSG, safeSend } from "./constants.js";

let _wss = null;

export function initSimulationService(wss) {
  _wss = wss;

  wss.on("connection", (ws) => {
    // send initial snapshot (non-fatal)
    safeSend(ws, MSG.SNAPSHOT(sim.snapshot()));

    ws.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch (e) {
        console.error("invalid json from client", e);
        safeSend(ws, MSG.ERROR("Invalid JSON payload"));
        return;
      }

      const handlers = createHandlers({ sim });

      try {
        const cmd = (data.cmd || "").toString();
        const handler = handlers[cmd];
        if (typeof handler === "function") {
          handler(data, ws);
        } else {
          safeSend(ws, MSG.ERROR("Unknown command: " + cmd));
        }
      } catch (e) {
        console.error("Error handling message in initSimulationService:", e);
        safeSend(ws, MSG.ERROR("Internal server error"));
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
  _utilSamples: [], // { ts, totalUtilTime, servedCount } samples for sliding-window util

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
    const tickRate = process.env.NODE_ENV === "PRODUCTION" ? 1000 : 200;
    this.tickIntervalHandle = setInterval(() => this._tick(tickRate), tickRate); // rate limiting

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
      running: this.running,
    };
  },

  metricsSnapshot() {
    const now = this.clock.now();
    const served = this.servedRequests || [];

    // Average wait: pickupTime (or servedAt) - timestamp
    const avgWait = served.length
      ? served.reduce(
          (a, b) => a + ((b.pickupTime || b.servedAt) - b.timestamp),
          0
        ) / served.length
      : 0;

    // Max wait among served
    const maxWait = served.length
      ? served.reduce(
          (m, b) => Math.max(m, (b.pickupTime || b.servedAt) - b.timestamp),
          0
        )
      : 0;

    // Average travel: dropoffTime - pickupTime
    const avgTravel = served.length
      ? served.reduce(
          (a, b) =>
            a +
            ((b.dropoffTime || b.completedAt) - (b.pickupTime || b.servedAt)),
          0
        ) / served.length
      : 0;

    // Max travel among served
    const maxTravel = served.length
      ? served.reduce(
          (m, b) =>
            Math.max(
              m,
              (b.dropoffTime || b.completedAt) - (b.pickupTime || b.servedAt)
            ),
          0
        )
      : 0;

    // Cumulative utilization: fraction of sim-time carrying passengers since start
    const util = this.elevators.length
      ? this.elevators.reduce((a, e) => a + (e.utilTime || 0), 0) /
        (this.elevators.length * (now || 1))
      : 0;

    // Pending requests stats (current waits)
    const pending = this.pendingRequests || [];
    const pendingCount = pending.length;
    const pendingWaits = pending.map((r) =>
      Math.max(0, now - (r.timestamp || now))
    );
    const maxPendingWait = pendingWaits.length ? Math.max(...pendingWaits) : 0;

    // --- Recent utilization & throughput (sliding window) ---
    const windowMs = 60 * 1000; // 60s window
    let recentUtil = 0;
    let throughputPerMin = 0;

    try {
      this._utilSamples = this._utilSamples || [];
      const samples = this._utilSamples;
      if (samples.length >= 2) {
        // find latest sample (last) and the earliest sample within the window
        const latest = samples[samples.length - 1];
        // find the oldest sample with ts >= latest.ts - windowMs (or fallback to first)
        const windowStartTs = latest.ts - windowMs;
        let oldestIndex = 0;
        for (let i = samples.length - 1; i >= 0; i--) {
          if (samples[i].ts < windowStartTs) {
            oldestIndex = Math.min(i + 1, samples.length - 1);
            break;
          }
          // if loop finishes without break, oldestIndex stays 0
        }
        const oldest = samples[oldestIndex];

        const deltaUtil = Math.max(
          0,
          latest.totalUtilTime - (oldest.totalUtilTime || 0)
        );
        const deltaServed =
          (latest.servedCount || 0) - (oldest.servedCount || 0);
        const deltaTime = Math.max(1, latest.ts - oldest.ts); // ms

        recentUtil =
          this.elevators.length > 0
            ? deltaUtil / (this.elevators.length * deltaTime)
            : 0;

        throughputPerMin = (deltaServed / deltaTime) * 60_000;
      }
    } catch (e) {
      console.warn("[sim] metrics recent calc error", e);
    }

    return {
      servedCount: served.length,
      avgWait,
      maxWait,
      avgTravel,
      maxTravel,
      utilization: util, // cumulative fraction
      recentUtil, // fraction over last windowMs
      throughputPerMin,
      pendingCount,
      maxPendingWait,
    };
  },

  addManualRequest({
    type = "external",
    origin = 1,
    destination = 2,
    elevatorId = null,
    isMorningRush = false,
  } = {}) {
    const r = {
      id: uuidv4(),
      timestamp: this.clock.now(),
      type,
      origin,
      destination,
      basePriority: 1,
      priority: 1,
      ...(isMorningRush ? { isMorningRush: true } : {}), // custom flag for lobby-bias
    };

    // Internal request from inside an elevator: attempt to assign immediately
    if (type === "internal" && elevatorId != null) {
      const elev = this.elevators.find(
        (x) => String(x.id) === String(elevatorId)
      );
      if (!elev) {
        return { ok: false, message: `Elevator ${elevatorId} not found.` };
      }

      // Check capacity
      if (elev.passengerCount >= elev.capacity) {
        return { ok: false, message: `Elevator ${elevatorId} is full.` };
      }

      // assign to the elevator immediately and treat passenger as already onboard
      r.assignedTo = elev.id;
      r.pickupTime = this.clock.now(); // already onboard
      // schedule dropoff
      if (r.destination != null && !elev.targetFloors.includes(r.destination)) {
        elev.targetFloors.push(r.destination);
      }
      elev.passengerCount = (elev.passengerCount || 0) + 1;

      // push to pendingRequests so dropoff is handled later
      this.pendingRequests.push(r);
      return {
        ok: true,
        message: `Request added to elevator ${elev.id}`,
        request: r,
      };
    }

    // Default: push as normal (external/internal without elevatorId)
    this.pendingRequests.push(r);
    return { ok: true, message: "Request queued", request: r };
  },

  /**
   * Set request spawn frequency (requests per minute).
   * Spawns uniformly-random external requests while the sim is running.
   * NOTE: This is not used currently and is commented out in frontend too.
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

        let origin, destination;

        // Morning rush bias (09:00–09:30) — ~70% lobby->upper, ~30% uniform random
        if (this._isMorningRushWindow()) {
          if (Math.random() < 0.7) {
            // 70%: lobby origin -> choose an upward destination
            origin = this.config.lobbyFloor || 1;
            const minDest = Math.max(origin + 1, 1);
            const maxDest = this.config.nFloors || 2;
            if (maxDest >= minDest) {
              destination =
                Math.floor(Math.random() * (maxDest - minDest + 1)) + minDest;
            } else {
              // fallback to any other floor (defensive)
              do {
                destination =
                  Math.floor(Math.random() * this.config.nFloors) + 1;
              } while (destination === origin);
            }
          } else {
            // 30%: uniform random origin/destination
            origin = Math.floor(Math.random() * this.config.nFloors) + 1;
            do {
              destination = Math.floor(Math.random() * this.config.nFloors) + 1;
            } while (destination === origin);
          }
        } else {
          // Non-rush: uniform random origin/destination
          origin = Math.floor(Math.random() * this.config.nFloors) + 1;
          do {
            destination = Math.floor(Math.random() * this.config.nFloors) + 1;
          } while (destination === origin);
        }

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

  // ---- All Morning Rush requests will be generated from lobby floor-------
  // spawnScenario(name, _count = null) {
  //   const count =
  //     typeof _count === "number"
  //       ? _count
  //       : name === "morningRush"
  //       ? 50
  //       : name === "randomBurst"
  //       ? 100
  //       : 10;

  //   const pickRandomFloorExcept = (excludeFloor) => {
  //     if (this.config.nFloors <= 1) return excludeFloor; // degenerate
  //     let f;
  //     do {
  //       f = Math.floor(Math.random() * this.config.nFloors) + 1;
  //     } while (f === excludeFloor);
  //     return f;
  //   };

  //   if (name === "morningRush") {
  //     // Morning Rush: majority from lobby to upper floors.
  //     for (let i = 0; i < count; i++) {
  //       // For clarity: choose destination uniformly among floors != lobbyFloor,
  //       // but prefer upper floors if possible by retrying until destination > lobbyFloor.
  //       const origin = this.config.lobbyFloor || 1;
  //       let destination = pickRandomFloorExcept(origin);

  //       // If building has floors above the lobby, bias to upper floors (try up to a few times)
  //       if (this.config.nFloors > origin) {
  //         let tries = 0;
  //         while (destination <= origin && tries < 6) {
  //           destination =
  //             Math.floor(Math.random() * (this.config.nFloors - origin)) +
  //             origin +
  //             1;
  //           tries++;
  //         }
  //         // fallback already guaranteed to be != origin
  //       }

  //       // Use addManualRequest to ensure consistent id/timestamp/defaults
  //       this.addManualRequest({
  //         type: "external",
  //         origin,
  //         destination,
  //         basePriority: 1,
  //         priority: 1,
  //       });
  //     }
  //   } else if (name === "randomBurst") {
  //     for (let i = 0; i < count; i++) {
  //       const origin = Math.floor(Math.random() * this.config.nFloors) + 1;
  //       const destination = pickRandomFloorExcept(origin);

  //       this.addManualRequest({
  //         type: "external",
  //         origin,
  //         destination,
  //         basePriority: 1,
  //         priority: 1,
  //       });
  //     }
  //   } else {
  //     // generic named scenario fallback: spawn `count` uniformly random requests
  //     for (let i = 0; i < count; i++) {
  //       const origin = Math.floor(Math.random() * this.config.nFloors) + 1;
  //       const destination = pickRandomFloorExcept(origin);
  //       this.addManualRequest({ type: "external", origin, destination });
  //     }
  //   }
  // },

  spawnScenario(name, _count = null) {
    const count =
      typeof _count === "number"
        ? _count
        : name === "morningRush"
        ? 50
        : name === "randomBurst"
        ? 100
        : 10;

    // helper to pick a destination != origin
    const pickRandomFloorExcept = (excludeFloor) => {
      if (this.config.nFloors <= 1) return excludeFloor; // degenerate
      let f;
      do {
        f = Math.floor(Math.random() * this.config.nFloors) + 1;
      } while (f === excludeFloor);
      return f;
    };

    if (name === "morningRush") {
      const lobbyRatio = 0.7;
      const numLobby = Math.round(count * lobbyRatio);
      const numOthers = count - numLobby;

      // generate exact number of lobby-biased requests
      for (let i = 0; i < numLobby; i++) {
        const origin = this.config.lobbyFloor || 1;
        // upward preference
        const minDest = Math.max(origin + 1, 1);
        const maxDest = this.config.nFloors || 2;
        const destination =
          maxDest >= minDest
            ? Math.floor(Math.random() * (maxDest - minDest + 1)) + minDest
            : pickRandomFloorExcept(origin);

        this.addManualRequest({
          type: "external",
          origin,
          destination,
          basePriority: 1,
          priority: 1,
          isMorningRush: true,
        });
      }

      // generate remaining uniformly-random requests
      for (let i = 0; i < numOthers; i++) {
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
        // PICKUP: assigned to this elevator and waiting to be picked up at this floor
        if (
          r.assignedTo === e.id &&
          r.origin === e.currentFloor &&
          !r.pickupTime
        ) {
          // If there's space, board passenger. Otherwise unassign so scheduler can reassign.
          if ((e.passengerCount || 0) < e.capacity) {
            r.pickupTime = this.clock.now();
            e.passengerCount += 1;

            // Ensure dropoff is scheduled (in case assignment missed it)
            if (
              r.destination != null &&
              !e.targetFloors.includes(r.destination)
            ) {
              e.targetFloors.push(r.destination);
            }
          } else {
            // no space: unassign this request so it will be available for other elevators
            r.assignedTo = null;
            // r.priority = Math.max(1, (r.priority || 1) - 0.05);
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
          // Decrement passenger count after dropoff
          e.passengerCount = Math.max(0, e.passengerCount - 1);
          this.servedRequests.push(r);
          // remove from pending - safe to mutate here since we're iterating over a slice
          this.pendingRequests = this.pendingRequests.filter(
            (x) => x.id !== r.id
          );
        }
      }

      e.targetFloors.shift();
      return;
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
      if (this.scheduler && typeof this.scheduler.assign === "function") {
        this.scheduler.assign();
      }
    } catch (err) {
      console.error(`Error in function _tick: ${err}`);
    }

    // update utilTime per-elevator
    for (const e of this.elevators) {
      e.utilTime = (e.utilTime || 0) + (e.passengerCount > 0 ? simDt : 0);
    }

    // --- Sampling for recent utilization & throughput ---
    try {
      const now = this.clock.now();
      const totalUtilTime = this.elevators.reduce(
        (a, e) => a + (e.utilTime || 0),
        0
      );
      const servedCount = this.servedRequests.length || 0;
      // push a sample
      this._utilSamples = this._utilSamples || [];
      this._utilSamples.push({ ts: now, totalUtilTime, servedCount });

      // prune samples older than 2 * windowMs (keep a little headroom)
      const windowMs = 60 * 1000; // 60s sliding window
      const pruneBefore = now - windowMs * 2;
      while (
        this._utilSamples.length &&
        this._utilSamples[0].ts < pruneBefore
      ) {
        this._utilSamples.shift();
      }
    } catch (e) {
      // non-fatal
      console.warn("[sim] util sampling error", e);
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

export const getSimulationService = () => sim;
