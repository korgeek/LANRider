import * as THREE from 'three';
import { nearestTrack } from '../shared/game.js';

export const sunsetStrength = altitude => THREE.MathUtils.smoothstep(-altitude, .833, 2);

export function createVehicleLights(root) {
  const variants = new Map(); let current, night = 0, braking = false;
  const lights = {
    bind(body) {
      if (!variants.has(body)) {
        const channels = [];
        for (const kind of ['head','tail','brake']) body.getObjectByName(`light_${kind}_mesh`).traverse(mesh=>{
          if (!mesh.isMesh) return;
          const original = mesh.material, materials = (Array.isArray(original)?original:[original]).map(source=>({material:source.clone(),strength:source.emissiveIntensity}));
          mesh.material = Array.isArray(original)?materials.map(e=>e.material):materials[0].material;
          mesh.castShadow = false; channels.push({kind,mesh,original,materials});
        });
        variants.set(body,channels);
      }
      current = variants.get(body); lights.update(night,braking);
    },
    update(strength, brake = false) {
      night = strength; braking = brake;
      for (const channel of current) for (const {material,strength:base} of channel.materials) {
        material.emissiveIntensity = base * (channel.kind === 'brake' ? Number(braking) : night);
      }
    },
    dispose() {
      for(const channels of variants.values())for(const channel of channels){channel.mesh.material=channel.original;for(const {material}of channel.materials)material.dispose();}
      variants.clear();
    },
  };
  lights.bind(root); return lights;
}

export function createHeadlights() {
  const group = new THREE.Group(); group.name = 'focused-headlights';
  // ponytail: one shared beam for the camera's car; add remote beams only if gameplay needs them.
  const light = new THREE.SpotLight('#fff1d5', 0, 48, Math.PI / 7, .75, 2);
  light.position.set(0, .58, -1.1); light.target.position.set(0, 0, -17);
  light.castShadow = false; light.visible = false; group.add(light, light.target);
  const left = new THREE.Vector3(), right = new THREE.Vector3();
  return { group, update(strength, root) {
    if (root) {
      root.updateWorldMatrix(true,true);
      root.getObjectByName('light_head_l_anchor').getWorldPosition(left);
      root.getObjectByName('light_head_r_anchor').getWorldPosition(right);
      light.position.copy(root.worldToLocal(left.add(right).multiplyScalar(.5)));
      light.target.position.set(light.position.x,0,light.position.z-17);
    }
    light.visible = strength > 0; light.intensity = 650 * strength;
  } };
}

export function createPalmDownlights(scenery, track) {
  const strength = { value: 0 }, placements = [], matrix = new THREE.Matrix4();
  const palms = [];
  scenery.traverse(mesh => {
    if (mesh.isInstancedMesh && (mesh.userData.palm || /palm/.test(mesh.name)) && mesh.geometry.attributes.color) palms.push(mesh);
  });
  for (const mesh of palms) {
    mesh.geometry.computeBoundingBox();
    const bounds = mesh.geometry.boundingBox, height = bounds.max.y - bounds.min.y;
    if (!height) continue;
    const material = mesh.material.clone(); mesh.material = material;
    // ponytail: baked warm trunk lighting, without occlusion; use real spots only if moving shadows become necessary.
    material.onBeforeCompile = shader => {
      shader.uniforms.palmNightStrength = strength;
      shader.vertexShader = 'varying float vPalmDownlight;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        float tall = step(7.0, length(instanceMatrix[1].xyz) * ${height.toFixed(6)});
        float trunk = 1.0 - smoothstep(0.92, 1.12, color.g / max(color.r, 0.001));
        float level = clamp((position.y - ${bounds.min.y.toFixed(6)}) / ${height.toFixed(6)}, 0.0, 1.0);
        vPalmDownlight = tall * trunk * (0.3 + 0.7 * level) * (1.0 - smoothstep(0.75, 0.9, level));`);
      shader.fragmentShader = 'uniform float palmNightStrength;\nvarying float vPalmDownlight;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(0.65, 0.32, 0.09) * vPalmDownlight * palmNightStrength;');
    };
    material.customProgramCacheKey = () => `palm-downlight/${height}/${bounds.min.y}`;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      if (height * new THREE.Vector3().setFromMatrixColumn(matrix, 1).length() < 7) continue;
      const position = new THREE.Vector3(0, bounds.min.y, 0).applyMatrix4(matrix);
      const road = nearestTrack(position.x, position.z, track);
      const direction = new THREE.Vector3(road.x - position.x, 0, road.z - position.z);
      const reach = Math.min(direction.length(), 18); direction.normalize();
      position.addScaledVector(direction, reach / 2); position.y = Math.max(position.y + .095, .045);
      placements.push(new THREE.Matrix4().makeRotationY(Math.atan2(direction.x, direction.z))
        .scale(new THREE.Vector3(10, 1, reach + 8)).setPosition(position));
    }
  }
  const geometry = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    uniforms: { strength },
    vertexShader: `varying vec2 vUv;
      void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);}`,
    fragmentShader: `varying vec2 vUv;uniform float strength;
      void main(){float radius=length(vUv*2.0-1.0);float glow=pow(1.0-smoothstep(0.0,1.0,radius),2.0);
        gl_FragColor=vec4(1.0,0.57,0.19,glow*strength*0.28);
        #include <colorspace_fragment>
      }`,
  });
  const pools = new THREE.InstancedMesh(geometry, material, placements.length); pools.name = 'palm-downlight-pools';
  placements.forEach((matrix, i) => pools.setMatrixAt(i, matrix));
  if (placements.length) pools.computeBoundingSphere();
  pools.visible = false; scenery.add(pools);
  return { update(sunAltitude) {
    strength.value = THREE.MathUtils.smoothstep(-sunAltitude, 6, 8);
    pools.visible = strength.value > 0 && placements.length > 0;
  } };
}
