export const createElevator = (id, initialFloor = 1, capacity = 6) => {
  return {
    id: String(id),
    currentFloor: initialFloor,
    targetFloors: [],
    direction: "idle",
    doorState: "closed",
    passengerCount: 0,
    capacity,
    statusSince: 0, // will be set to sim.clock.now() in sim.init()
    // Rebalancer helpers:
    // _rebalanceTarget: null, // floor we are repositioning to (set by rebalancer)
    // _lastRebalanceTime: 0, // sim-time when last rebalancing finished
    _accTime: 0, // accumulator for movement (keeps progress between ticks)
  };
};
