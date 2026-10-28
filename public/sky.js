import * as THREE from 'three';
import { calculateSky, starPosition } from '../shared/sky.js';

const RAD = Math.PI / 180, DISTANCE = 720;
// Art calibration: double the real angular diameter so discs read at driving resolution.
const BODY_SCALE = 2, BODY_RADIUS = .2666 * BODY_SCALE;
const smooth = THREE.MathUtils.smoothstep;
function direction({ altitude, azimuth }, radius = 1, vector = new THREE.Vector3()) {
  const alt = altitude * RAD, az = azimuth * RAD;
  // World north = -Z, east = +X, independent of the car/camera heading.
  return vector.set(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt)).multiplyScalar(radius);
}

export function createSky(scene, renderer, clouds, catalogue) {
  const domeMaterial = new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false,
    uniforms: { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() },
      sunDirection: { value: new THREE.Vector3() }, twilight: { value: 0 } },
    vertexShader: `varying vec3 vDirection;
      void main() { vDirection = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 vDirection;
      uniform vec3 top, horizon, sunDirection; uniform float twilight;
      void main() {
        vec3 d = normalize(vDirection);
        vec3 color = mix(horizon, top, pow(max(d.y, 0.0), 0.45));
        float glow = pow(max(dot(d, sunDirection), 0.0), 8.0) * exp(-abs(d.y) * 4.0);
        color += vec3(0.55, 0.11, 0.025) * glow * twilight;
        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(880, 32, 20), domeMaterial);
  dome.name = 'sky-dome'; dome.renderOrder = -100; dome.frustumCulled = false; scene.add(dome);
  const heavens = new THREE.Group(); heavens.name = 'sky-celestial'; scene.add(heavens);
  const starGeometry = new THREE.BufferGeometry(), positions = new Float32Array(catalogue.stars.length * 3);
  starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  starGeometry.setAttribute('magnitude', new THREE.Float32BufferAttribute(catalogue.stars.map(star => star[2]), 1));
  const starMaterial = new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
    uniforms: { visibility: { value: 0 }, pixelRatio: { value: 1 } },
    vertexShader: `attribute float magnitude; uniform float pixelRatio; varying float brightness, height;
      void main() { height = position.y; brightness = pow(10.0, -0.16 * (magnitude + 1.5));
        gl_PointSize = (1.5 + max(0.0, 4.5 - magnitude) * 0.6) * pixelRatio;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float visibility; varying float brightness, height;
      void main() { float r = length(gl_PointCoord - 0.5) * 2.0;
        if (r > 1.0 || height < 0.0) discard;
        gl_FragColor = vec4(vec3(0.8, 0.88, 1.0), visibility * brightness * (1.0 - smoothstep(0.2, 1.0, r)));
        #include <colorspace_fragment>
      }`,
  });
  const stars = new THREE.Points(starGeometry, starMaterial); stars.name = 'sky-stars';
  stars.frustumCulled = false; stars.renderOrder = -8; heavens.add(stars);
  const segments = catalogue.constellations.flatMap(figure => figure.paths.flatMap(path =>
    path.slice(1).flatMap((point, i) => [path[i], point])));
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(segments.length * 3), 3));
  const lines = new THREE.LineSegments(lineGeometry, new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
    uniforms: { visibility: { value: 0 } },
    vertexShader: `varying float height; void main() { height = position.y;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float visibility; varying float height;
      void main() { if (height < 0.0) discard; gl_FragColor = vec4(0.35, 0.55, 0.8, visibility * 0.13);
        #include <colorspace_fragment>
      }`,
  }));
  lines.name = 'sky-constellations'; lines.frustumCulled = false; lines.renderOrder = -9; heavens.add(lines);
  function disc(name, moon) {
    const material = new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
      uniforms: { light: { value: new THREE.Vector3() }, opacity: { value: 1 }, altitude: { value: 0 },
        tint: { value: new THREE.Color('#fff0c9') } },
      vertexShader: `varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec2 vUv; uniform vec3 light, tint; uniform float opacity, altitude;
        void main() {
          vec2 p = vUv * 2.0 - 1.0; float r2 = dot(p, p);
          if (r2 > 1.0 || altitude + p.y * ${BODY_RADIUS.toFixed(5)} < 0.0) discard;
          vec3 normal = vec3(p, sqrt(max(0.0, 1.0 - r2)));
          float lit = ${moon ? 'smoothstep(-0.015, 0.06, dot(normal, light))' : '1.0'};
          float grain = ${moon ? '(0.89 + 0.06 * sin(p.x * 19.0 + sin(p.y * 13.0)) * sin(p.y * 23.0))' : '1.0'};
          gl_FragColor = vec4(tint * (0.012 + lit * grain), opacity * (1.0 - smoothstep(0.98, 1.0, r2)));
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.scale.setScalar(2 * DISTANCE * Math.tan(BODY_RADIUS * RAD));
    mesh.name = name; mesh.renderOrder = -7; heavens.add(mesh); return mesh;
  }
  const sunDisc = disc('sky-sun', false), moonDisc = disc('sky-moon', true);
  const fill = new THREE.HemisphereLight('#d8f3ff', '#a5bfcb', 1.35); fill.name = 'sky-fill'; scene.add(fill);
  const key = new THREE.DirectionalLight('#fff2da', 2.65); key.name = 'sky-key';
  key.shadow.mapSize.set(2048, 2048); key.shadow.normalBias = .03;
  Object.assign(key.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 1, far: 180 });
  key.shadow.camera.updateProjectionMatrix(); scene.add(key, key.target);
  const fog = new THREE.Fog('#b1ddef', 180, 850); scene.fog = fog;
  let environment, anchor = 0, lastUpdate = -Infinity, calculated;
  const sunDirection = new THREE.Vector3(), moonDirection = new THREE.Vector3(), scratch = new THREE.Vector3();
  const nightTop = new THREE.Color('#040b22'), dayTop = new THREE.Color('#46a7ef');
  const nightHorizon = new THREE.Color('#17233e'), dayHorizon = new THREE.Color('#c2eafa');
  const dusk = new THREE.Color('#df795f'), gray = new THREE.Color('#9aaebc');
  return {
    sunAltitude() { return calculated?.sun.altitude ?? 90; },
    setEnvironment(value) { environment = { ...value }; anchor = performance.now(); lastUpdate = -Infinity; },
    update(camera, focus) {
      if (!environment) return;
      const now = performance.now(), timestamp = environment.timestamp + now - anchor;
      dome.position.copy(camera.position); heavens.position.copy(camera.position);
      if (now - lastUpdate >= 1000) {
        lastUpdate = now; calculated = calculateSky(timestamp, environment.latitude, environment.longitude);
        const { sun, moon } = calculated, day = smooth(sun.altitude, -8, 12);
        const twilight = (1 - smooth(Math.abs(sun.altitude), 0, 14)) * smooth(sun.altitude, -12, -3);
        const cover = (environment.cloudCover ?? 35) / 100, night = 1 - smooth(sun.altitude, -18, -5);
        const visibility = night * (1 - cover) * (1 - (moon.altitude > 0 ? moon.fraction * .35 : 0));
        direction(sun, 1, sunDirection); direction(moon, 1, moonDirection);
        domeMaterial.uniforms.top.value.copy(nightTop).lerp(dayTop, day).lerp(gray, cover * day * .65);
        domeMaterial.uniforms.horizon.value.copy(nightHorizon).lerp(dayHorizon, day).lerp(dusk, twilight * .72).lerp(gray, cover * day * .55);
        domeMaterial.uniforms.sunDirection.value.copy(sunDirection); domeMaterial.uniforms.twilight.value = twilight * (1 - cover);
        fog.color.copy(domeMaterial.uniforms.horizon.value);
        scene.environmentIntensity = .08 + day * .24; renderer.toneMappingExposure = 1.2 - day * .15;
        fill.intensity = .62 + day * .73; fill.color.set(day > .5 ? '#d8f3ff' : '#91a9de');
        key.intensity = sun.altitude > 0 ? 2.65 * smooth(sun.altitude, 0, 18) * (1 - cover * .65)
          : .25 * moon.fraction * smooth(moon.altitude, 0, 20);
        key.color.set(sun.altitude > 0 ? twilight > .3 ? '#ffb973' : '#fff2da' : '#a8bfff'); key.castShadow = sun.altitude > 1;
        sunDisc.position.copy(sunDirection).multiplyScalar(DISTANCE); sunDisc.visible = sun.altitude > -BODY_RADIUS;
        sunDisc.material.uniforms.altitude.value = sun.altitude; sunDisc.material.uniforms.opacity.value = 1 - cover * .85;
        sunDisc.material.uniforms.tint.value.set(sun.altitude < 8 ? '#ffb35b' : '#fff4d6');
        moonDisc.position.copy(moonDirection).multiplyScalar(DISTANCE); moonDisc.visible = moon.altitude > -BODY_RADIUS && moon.fraction > .001;
        moonDisc.material.uniforms.altitude.value = moon.altitude; moonDisc.material.uniforms.opacity.value = (1 - day * .85) * (1 - cover * .9);
        moonDisc.material.uniforms.tint.value.set('#e5eafa');
        const litZ = moon.fraction * 2 - 1, planar = Math.sqrt(Math.max(0, 1 - litZ * litZ)), tilt = moon.tilt * RAD;
        moonDisc.material.uniforms.light.value.set(-Math.sin(tilt) * planar, Math.cos(tilt) * planar, litZ);
        starMaterial.uniforms.visibility.value = visibility; starMaterial.uniforms.pixelRatio.value = renderer.getPixelRatio?.() ?? 1;
        lines.material.uniforms.visibility.value = visibility;
        catalogue.stars.forEach(([ra, dec], i) => direction(starPosition(timestamp, environment.latitude, environment.longitude, ra, dec), DISTANCE, scratch).toArray(positions, i * 3));
        segments.forEach(([ra, dec], i) => direction(starPosition(timestamp, environment.latitude, environment.longitude, ra, dec), DISTANCE - 1, scratch)
          .toArray(lineGeometry.attributes.position.array, i * 3));
        starGeometry.attributes.position.needsUpdate = lineGeometry.attributes.position.needsUpdate = true;
        clouds.children.forEach((cloud, i) => { cloud.visible = i < Math.round(cover * clouds.children.length); });
      }
      heavens.updateMatrixWorld(true); sunDisc.lookAt(camera.position); moonDisc.lookAt(camera.position);
      key.position.copy(calculated.sun.altitude > 0 ? sunDirection : moonDirection).multiplyScalar(100);
      key.position.x += focus.x; key.position.z += focus.z; key.target.position.set(focus.x, 0, focus.z);
    },
  };
}
