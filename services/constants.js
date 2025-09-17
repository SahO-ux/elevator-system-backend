const ETA_WEIGHT = 0.0015; // cost per simulated ms of eta (tuned)
const SAME_FLOOR_BOOST = 10000; // elevator already at origin -> almost always pick
const NEARBY_BOOST = 75; // 1-floor-away boost (slightly increased)
const DIRECTION_BOOST = 20; // same direction boost
const TARGET_PENALTY = 12; // penalty per pending target in elevator (increased)
const OCCUPANCY_PENALTY_NEAR = 200; // penalty if near capacity
const OCCUPANCY_PENALTY_FULL = 10000; // huge penalty if full
const FAIRNESS_WEIGHT = 0.00008; // penalize elevator with high utilTime slightly

const occupancyPenalty = (elevator) => {
  if (elevator.passengerCount >= elevator.capacity)
    return OCCUPANCY_PENALTY_FULL;
  if (elevator.passengerCount >= Math.floor(elevator.capacity * 0.8))
    return OCCUPANCY_PENALTY_NEAR;
  return 0;
};

/**
 * estimateETA(elevator, pickupFloor, timePerFloor, doorDwell)
 * Simulate elevator's remaining travel time in sim-ms to reach pickupFloor,
 * taking into account elevator.currentFloor, elevator.targetFloors sequence,
 * timePerFloor (ms per floor), and doorDwell (ms per stop).
 *
 * This is a better approximation of true ETA because it accounts for
 * intermediate stops already scheduled for the elevator.
 */
const estimateETA = (
  elevator,
  pickupFloor,
  timePerFloor = 1000,
  doorDwell = 2000
) => {
  // defensive defaults
  const cur = elevator.currentFloor || 1;
  const targets = (elevator.targetFloors && [...elevator.targetFloors]) || [];

  // if no targets, straight-line ETA
  if (!targets.length) {
    return Math.abs(cur - pickupFloor) * timePerFloor;
  }

  let total = 0;
  let curFloor = cur;

  // walk through scheduled targets in order; include travel + doorDwell for each stop.
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    // travel to next scheduled stop
    total += Math.abs(t - curFloor) * timePerFloor;
    // if that stop is the pickup floor, we have arrived
    if (t === pickupFloor) return total;
    // otherwise we'll dwell here (passengers in/out) before continuing
    total += doorDwell;
    curFloor = t;
  }

  // after finishing all scheduled targets, go to pickup if not already reached
  total += Math.abs(pickupFloor - curFloor) * timePerFloor;
  return total;
};

/**
 * computeScore(elevator, request, timePerFloor)
 * Uses new estimateETA to compute a more realistic score. Also adds a small fairness
 * penalty proportional to elevator.utilTime (so very busy elevators are slightly deprioritized).
 */
const computeScore = (
  elevator,
  request,
  timePerFloor = 1000,
  doorDwell = 2000
) => {
  const pickupFloor =
    request.origin != null ? request.origin : request.destination;
  const eta = estimateETA(elevator, pickupFloor, timePerFloor, doorDwell); // sim-ms
  const base = request.priority || 1;

  let score = base;

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

  // fairness: penalize elevators that have accumulated a lot of utilTime (already busy)
  // smaller weight so it nudges choice rather than dominating
  const utilTime = elevator.utilTime || 0;
  score -= utilTime * FAIRNESS_WEIGHT;

  // after base calculation
  if (request.escalated) {
    score += 5000; // make escalated requests jump to front
  }

  return { score, eta };
};

/**
 * updatePriorities(now, sim)
 * existing logic (keeps escalation after 30s, lobby bias)
 */
const updatePriorities = (now, sim) => {
  for (const r of sim.pendingRequests) {
    const waited = now - r.timestamp;
    r.priority = (r.basePriority || 1) + waited * 0.001;

    if (!r.escalated && waited >= 30_000) {
      r.escalated = true;
      r.priority += 2000; // bigger boost on escalation to ensure assignment
      //   r.priority += 5000;
    }

    if (
      sim.config.lobbyFloor &&
      r.origin === sim.config.lobbyFloor &&
      sim._isMorningRushWindow()
    ) {
      r.priority += r.priority * 0.5; // 50% boost for lobby in morning window
    }
  }
};

export { updatePriorities, computeScore, estimateETA };
