export const createSimClock = () => {
  return {
    simTime: 0,
    speed: 1,
    advance(dt) {
      this.simTime += dt * this.speed;
    },
    now() {
      return this.simTime;
    },
    setSpeed(s) {
      this.speed = s;
    },
  };
};
