import * as THREE from 'three';

// Degrees in model space, tuned to remain visible at the chase camera distance.
export const DRIVER_MOTION = { headPitch: 8, headYaw: 5, headRoll: 6, chestPitch: 4, chestYaw: 1, chestRoll: 4, response: 9 };
const radians = THREE.MathUtils.degToRad;
const position = bone => bone.getWorldPosition(new THREE.Vector3());
const rotation = bone => bone.getWorldQuaternion(new THREE.Quaternion());

function setWorldRotation(bone, target) {
  bone.quaternion.copy(rotation(bone.parent).invert().multiply(target));
  bone.updateWorldMatrix(false, true);
}

function aim(bone, child, target) {
  const origin = position(bone);
  const change = new THREE.Quaternion().setFromUnitVectors(position(child).sub(origin).normalize(), target.clone().sub(origin).normalize());
  setWorldRotation(bone, change.multiply(rotation(bone)));
}

// Analytic two-bone arm constraint: animated hand targets stay on the wheel as shoulders lean.
function holdGrip(arm) {
  const [upper, forearm, hand] = arm.bones, shoulder = position(upper);
  const direction = arm.target.clone().sub(shoulder);
  const length = THREE.MathUtils.clamp(direction.length(), Math.abs(arm.a - arm.b) + .000001, arm.a + arm.b - .000001);
  direction.normalize();
  const pole = arm.elbow.clone().sub(shoulder);
  pole.addScaledVector(direction, -pole.dot(direction)).normalize();
  const along = (arm.a ** 2 - arm.b ** 2 + length ** 2) / (2 * length);
  const elbow = shoulder.clone().addScaledVector(direction, along).addScaledVector(pole, Math.sqrt(Math.max(0, arm.a ** 2 - along ** 2)));
  aim(upper, forearm, elbow); aim(forearm, hand, arm.target); setWorldRotation(hand, arm.rotation);
}

export function createDriverInertia(person) {
  const chest = person.getObjectByName('chest'), head = person.getObjectByName('head');
  const arms = ['l', 'r'].map(side => ({ bones: ['upper_arm', 'forearm', 'hand'].map(name => person.getObjectByName(`${name}_${side}`)) }));
  const bones = [chest, head, ...arms.flatMap(arm => arm.bones)], base = bones.map(bone => bone.quaternion.clone());
  let applied = false, lean = 0, boost = 0;
  return {
    beforeAnimation() {
      if (applied) bones.forEach((bone, i) => bone.quaternion.copy(base[i]));
      applied = false;
    },
    afterAnimation(car, dt) {
      bones.forEach((bone, i) => base[i].copy(bone.quaternion));
      if (car.finished) { lean = boost = 0; return; }
      const blend = 1 - Math.exp(-Math.min(Math.max(dt, 0), .1) * DRIVER_MOTION.response);
      lean = THREE.MathUtils.lerp(lean, THREE.MathUtils.clamp(car.steer || 0, -1, 1) * Math.min(Math.abs(car.speed || 0) / 12, 1), blend);
      boost = THREE.MathUtils.lerp(boost, car.boostTime > 0 ? 1 : 0, blend);
      person.updateWorldMatrix(true, true);
      const model = rotation(person), inverse = model.clone().invert();
      const animated = [rotation(chest), rotation(head)];
      for (const arm of arms) {
        const [upper, forearm, hand] = arm.bones;
        arm.target = position(hand); arm.elbow = position(forearm); arm.rotation = rotation(hand);
        arm.a = position(upper).distanceTo(arm.elbow); arm.b = arm.elbow.distanceTo(arm.target);
      }
      for (const [i, bone, prefix] of [[0, chest, 'chest'], [1, head, 'head']]) {
        const offset = new THREE.Quaternion().setFromEuler(new THREE.Euler(radians(DRIVER_MOTION[`${prefix}Pitch`] * boost),
          radians(-DRIVER_MOTION[`${prefix}Yaw`] * lean), radians(DRIVER_MOTION[`${prefix}Roll`] * lean)));
        setWorldRotation(bone, model.clone().multiply(offset).multiply(inverse).multiply(animated[i]));
      }
      arms.forEach(holdGrip); applied = true;
    },
  };
}
