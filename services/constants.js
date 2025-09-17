const ETA_WEIGHT = 0.01; // cost per simulated ms of eta (tune to taste)
const SAME_FLOOR_BOOST = 10000; // elevator already at origin -> almost always pick
const NEARBY_BOOST = 50; // 1-floor-away boost
const DIRECTION_BOOST = 20; // same direction boost
const TARGET_PENALTY = 8; // penalty per pending target in elevator
const OCCUPANCY_PENALTY_NEAR = 200; // penalty if near capacity
const OCCUPANCY_PENALTY_FULL = 10000; // huge penalty if full

const occupancyPenalty = (elevator) => {
  if (elevator.passengerCount >= elevator.capacity)
    return OCCUPANCY_PENALTY_FULL;
  // near capacity (e.g., >= 80%) has penalty
  if (elevator.passengerCount >= Math.floor(elevator.capacity * 0.8))
    return OCCUPANCY_PENALTY_NEAR;
  return 0;
};

const estimateETA = (elevator, floor, timePerFloor = 1000) => {
  const floorsAway = Math.abs(elevator.currentFloor - floor);
  // const timePerFloor = sim.config.timePerFloor;
  return floorsAway * timePerFloor; // ms per floor (sim-time)
};

// compute score for a given elevator-request pair
const computeScore = (elevator, request, timePerFloor) => {
  const pickupFloor =
    request.origin != null ? request.origin : request.destination;
  const eta = estimateETA(elevator, pickupFloor, timePerFloor); // sim-ms
  const base = request.priority || 1;

  let score = base;

  // same-floor strong boost (idle or stopping)
  const elevatorIdleOrStopping =
    elevator.direction === "idle" ||
    (elevator.targetFloors && elevator.targetFloors[0] === pickupFloor);
  if (elevator.currentFloor === pickupFloor && elevatorIdleOrStopping) {
    score += SAME_FLOOR_BOOST;
  } else if (Math.abs(elevator.currentFloor - pickupFloor) === 1) {
    score += NEARBY_BOOST;
  }

  // direction boost
  const reqDirection =
    request.destination != null && request.origin != null
      ? request.destination > request.origin
        ? "up"
        : "down"
      : request.direction;
  if (elevator.direction && reqDirection && elevator.direction === reqDirection)
    score += DIRECTION_BOOST;

  // ETA penalty (distant cars penalized)
  score -= eta * ETA_WEIGHT;

  // penalize number of targets (busier elevator less desirable)
  const targetsCount =
    (elevator.targetFloors && elevator.targetFloors.length) || 0;
  score -= targetsCount * TARGET_PENALTY;

  // occupancy
  score -= occupancyPenalty(elevator);

  return { score, eta };
};

const updatePriorities = (now, sim) => {
  for (const r of sim.pendingRequests) {
    const waited = now - r.timestamp;
    // base priority + small linear wait penalty
    r.priority = (r.basePriority || 1) + waited * 0.001;

    // escalate strongly if waited more than 30s
    if (!r.escalated && waited >= 30_000) {
      r.escalated = true;
      r.priority += 1000; // huge boost
    }

    // lobby bias if configured
    if (
      sim.config.lobbyFloor &&
      r.origin === sim.config.lobbyFloor &&
      sim._isMorningRushWindow()
    ) {
      r.priority += r.priority * 0.5; // 50% boost
    }
  }
};

export { updatePriorities, computeScore };
