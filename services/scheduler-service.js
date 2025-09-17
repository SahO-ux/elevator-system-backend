import {
  updatePriorities,
  // findBestForElevator,
  computeScore,
} from "./constants.js";

// Scheduler service (plain JS)
// Hybrid approach: directional batching (SCAN-like) + nearest-car scoring + escalation

export const createScheduler = (sim) => {
  // sim provides: elevators[], pendingRequests[], clock, config

  // Main assignment function, called periodically by simulation engine
  // Assigns pending requests to elevators based on their state and request properties
  // Uses a greedy global matching approach: evaluates all (idleElevator, pendingRequest) pairs, picks best repeatedly
  // Also does intra-trip batching for busy elevators (same as before)
  // Finally, does rebalancing of idle elevators to high-traffic floors if configured

  const assign = () => {
    const now = sim.clock.now();
    updatePriorities(now, sim);

    // Build list of free/idle elevators candidate for assignment and busy elevators
    const idleElevators = [];
    const busyElevators = [];

    for (const e of sim.elevators) {
      if (!e.targetFloors || e.targetFloors.length === 0) idleElevators.push(e);
      else busyElevators.push(e);
    }

    // Greedy global matching: evaluate all (idleElevator, pendingRequest) pairs, pick best repeatedly
    const unassignedRequests = sim.pendingRequests.filter((r) => !r.assignedTo);
    const availableElevators = [...idleElevators];

    // quick guard
    if (availableElevators.length > 0 && unassignedRequests.length > 0) {
      // create pair list
      const pairs = [];
      for (const e of availableElevators) {
        for (const r of unassignedRequests) {
          if (r.assignedTo) continue;
          const { score, eta } = computeScore(e, r, sim.config.timePerFloor);
          pairs.push({ elevator: e, request: r, score, eta });
        }
      }

      // sort descending by score (best first), tiebreaker by lower ETA
      pairs.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.eta - b.eta;
      });

      // greedy: pick best pair, assign, remove elevator and request from consideration, repeat
      const usedElevatorIds = new Set();
      const usedRequestIds = new Set();

      for (const p of pairs) {
        if (
          usedElevatorIds.has(p.elevator.id) ||
          usedRequestIds.has(p.request.id)
        )
          continue;
        if (p.elevator.passengerCount >= p.elevator.capacity) continue;

        // assign
        p.request.assignedTo = p.elevator.id;
        if (p.request.origin != null)
          p.elevator.targetFloors.push(p.request.origin);
        if (p.request.destination != null)
          p.elevator.targetFloors.push(p.request.destination);
        p.elevator.targetFloors = Array.from(new Set(p.elevator.targetFloors));

        // optional debug:
        // console.log(`[scheduler] assigned request ${p.request.id} to elevator ${p.elevator.id} (score ${p.score.toFixed(2)})`);

        usedElevatorIds.add(p.elevator.id);
        usedRequestIds.add(p.request.id);
      }
    }

    // For busy elevators, still attempt intra-trip batching (same as before)
    for (const e of busyElevators) {
      for (const r of sim.pendingRequests) {
        if (r.assignedTo) continue;
        const dir = e.direction;
        if (!dir) continue;
        const pickup = r.origin != null ? r.origin : r.destination;
        const between =
          dir === "up"
            ? pickup > e.currentFloor && pickup <= Math.max(...e.targetFloors)
            : pickup < e.currentFloor && pickup >= Math.min(...e.targetFloors);
        if (between) {
          r.assignedTo = e.id;
          e.targetFloors.push(pickup);
        }
      }
      e.targetFloors = Array.from(new Set(e.targetFloors));
    }
  };

  return { assign };
};
