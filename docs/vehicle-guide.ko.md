# 차량 추가 가이드

이 문서는 현재 LANRider에 차량을 추가하고 검증하는 절차입니다. 차량은 외형만 추가해서 완성되지 않습니다. 공유 물리, 충돌 상자, 모델의 부착점, 엔진음, 화면, 서버 검증과 테스트가 같은 차량 ID를 사용해야 합니다. 먼저 기존 차량 하나를 기준으로 비교하고, 새 차량과 기존 차량을 모두 확인합니다.

## 1. 차량 구상과 모델 준비

차량의 고유 ID, 이름, 특징과 운전 감각을 정합니다. ID는 기존처럼 영문 대문자(`PULSE` 등)를 사용합니다. 준비할 모델의 출처와 게임에 포함·공개할 권리를 먼저 확인하고, 해당 에셋의 실제 이용 조건을 [에셋 고지](../public/assets/licenses.md)에 반영합니다. 타인의 모델이나 음원에 프로젝트 아트 조건을 일괄 적용하지 않습니다.

현재 런타임은 각 차체에 일반과 경량 GLB가 필요합니다. 예를 들어 ID가 `EXAMPLE`이면 다음과 같이 놓습니다.

```text
public/assets/vehicles/v4/example/example_lod0.glb  # 일반
public/assets/vehicles/v4/example/example_lod1.glb  # 경량
```

기존 `pulse` 모델을 참고해 두 파일의 크기와 방향, 바퀴와 장착점의 위치를 맞춥니다. 현재 장면은 앞쪽이 음의 Z축, 위쪽이 양의 Y축이며, 기존 모델은 미터 단위입니다. 상·중 품질은 일반 모델, 하 품질은 경량 모델을 사용합니다. 경량 파일의 바퀴 축과 부착점은 일반 파일과 일치해야 품질을 바꿔도 차체나 운전자가 튀지 않습니다. 필요하다면 외부 모델링 도구로 제작하되, 공개 저장소에는 모델 제작 원본이나 자동 생성 도구가 포함되어 있다고 가정하지 않습니다.

[`public/models.js`](../public/models.js)의 `createVehicleModel`과 [`public/night-lights.js`](../public/night-lights.js)가 참조하는 주요 노드 이름을 두 모델 모두에 갖춥니다.

- 차체와 운전자: `body_mesh`, `driver_mount`. 현재 공용 드라이버는 `public/assets/drivers/vnext/driver_lod0.glb`를 사용합니다.
- 앞바퀴 조향축: `steer_fl`, `steer_fr`. 바퀴 회전축: `spin_fl`, `spin_fr`, `spin_rl`, `spin_rr`.
- 바퀴 형상: `wheel_fl`, `wheel_fr`, `wheel_rl`, `wheel_rr`. 부스트 위치: `boost_l`, `boost_r`.
- 운전자 손 위치를 확인하는 `hand_l_anchor`, `hand_r_anchor`와 조명용 `light_head_mesh`, `light_tail_mesh`, `light_brake_mesh`, `light_head_l_anchor`, `light_head_r_anchor`.

노드 이름만 있으면 충분한 것은 아닙니다. 바퀴가 지면에 닿고 축을 중심으로 회전하는지, 운전자의 손이 핸들과 맞는지, 부스트와 조명 위치가 차체에 맞는지 직접 확인합니다. 기존 테스트는 양쪽 부스트 위치, 차체의 같은 드라이버 장착 좌표, 바퀴 지면 높이와 일반·경량 축의 일치를 검증합니다. 구조나 모델 규격을 바꿔야 한다면 기존 차량과 공용 드라이버에도 미치는 영향을 살펴본 후 테스트의 기대값을 근거 있게 조정합니다.

## 2. 게임에 등록

1. [`public/models.js`](../public/models.js)의 `VEHICLE_MODELS`에 새 ID와 `*_lod0.glb` 경로를 등록합니다. `VEHICLE_LIGHT_MODELS`는 경로의 `_lod0.glb`를 `_lod1.glb`로 바꾸어 만들므로 이름과 경로를 맞춥니다. 두 파일이 없거나 필수 노드가 빠지면 장면 로딩에 실패할 수 있습니다.
2. [`shared/game.js`](../shared/game.js)의 `VEHICLES`에 같은 ID, 이름, 한국어 설명과 성능값을 추가합니다. 기존 차량을 기준으로 `PHYSICS`를 상속하고 가속, 최고속도, 회전, 접지, 드리프트, 부스트, 질량과 충돌 회복을 조정합니다. 속도의 코드 단위는 m/s이므로 km/h 수치는 3.6으로 나눕니다. `ratings`는 현재 프리셋에 저장되어 있지만 주행 물리나 화면에서 읽지 않으므로 실제 성능값을 대신하지 않습니다.
3. 모델의 실제 차체 폭·길이와 중심을 측정해 `collisionSize`와 `collisionOffset`을 정합니다. `collisionBox()`는 폭과 길이에 공통 `collisionScale` 0.9를 적용하고 공통 높이를 사용합니다. 공용 높이는 운전자를 포함하므로 새 모델이 그 범위를 벗어나지 않는지 검증합니다. 시각적 크기만 보고 충돌값을 추측하지 마세요.
4. [`public/engine-audio.js`](../public/engine-audio.js)의 `ENGINE_VEHICLES`에 같은 ID를 추가하고 기존 `sport` 또는 `rough` 엔진음을 선택합니다. 다른 소리를 쓰면 파일, 로더와 출처·이용 조건도 함께 확인합니다.
5. [`public/i18n.js`](../public/i18n.js)에 차량 설명의 영어 번역을 추가합니다. 선택지는 [`public/main.js`](../public/main.js)가 `VEHICLES`에서 만들고, [`server.js`](../server.js)는 같은 목록으로 차량 ID를 검증합니다. 방 생성·참가, 대기, 결과와 재경기에도 새 ID가 유지되는지 확인합니다.
6. `public/scene.js`와 `public/i18n.js`의 로딩 문구, 두 README의 차량 수, 에셋 고지 등에서 기존 차량 수를 직접 표시하는 곳을 실제 구성에 맞춥니다.

### 모델 치수와 삼각형 수 측정

`npm ci` 후 프로젝트 루트에서 아래 예시를 실행합니다. `MODEL`을 새 일반 또는 경량 GLB 경로로 바꾸어 각각 측정하세요. `width`, `length`는 `collisionSize`의 출발점이며 `forwardOffset`은 앞쪽이 음의 Z축인 현재 좌표계에서 충돌 중심의 출발점입니다. 최종 충돌 상자는 F3 화면과 실제 충돌로도 확인합니다.

```sh
MODEL=public/assets/vehicles/v4/pulse/pulse_lod0.glb node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
globalThis.self = globalThis;
const bytes = await readFile(process.env.MODEL);
const loader = new GLTFLoader();
loader.register(parser => { parser.textureLoader = { load(_url, done) { done(new THREE.Texture()); } }; return { name: 'NODE_TEXTURE_ADAPTER' }; });
const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
const box = new THREE.Box3().setFromObject(gltf.scene);
const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
let triangles = 0;
gltf.scene.traverse(node => {
  if (node.isMesh && !node.isSkinnedMesh) triangles += (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3;
});
console.log({ width: size.x, length: size.z, height: size.y, forwardOffset: -center.z, triangles });
JS
```

이 측정은 차체 GLB의 경계 기준이며 Node.js에서는 텍스처를 대체 객체로 처리합니다. 실제 텍스처 표시와 드라이버가 올라간 높이, 애니메이션, 바퀴 지면 접촉은 브라우저에서 별도로 확인합니다. GLB가 외부 파일을 참조하는 경우 해당 파일도 함께 제공하거나 내부에 포함하고 로더에서 정상적으로 읽히는지 검증합니다.

## 3. 자동 검증과 밸런스

기존 테스트 일부는 차량 8종의 ID, 장착 좌표, 삼각형 수, 속도나 비교 대상을 직접 열거합니다. 특히 `test/vehicle-v4.test.js`, `test/models.test.js`, `test/game.test.js`를 읽고 새 차량이 빠지지 않게 갱신합니다. 기존 8대의 조건을 삭제하거나 새 모델에 맞춰 일괄 완화하지 마세요. 새 모델의 삼각형 수와 치수는 실제 파일을 측정해 기준을 정합니다.

Node.js 24에서 `npm ci`를 실행한 뒤 관련 검사를 실행합니다.

```sh
node --test test/vehicle-v4.test.js test/models.test.js test/night-lights.test.js test/engine-audio.test.js
node --test test/game.test.js test/cornering.test.js test/race-stability.test.js test/i18n.test.js
node --test test/server.test.js test/client.test.js
npm test
```

서버·클라이언트 통합 테스트는 임시 로컬 포트가 필요합니다. 포트 바인딩이 환경에서 차단되면 애플리케이션 결함과 구분해 기록합니다. 새 차량의 정상 선택과 잘못된 ID 거부, 참가자에게 전달되는 차량, 출발 후 변경 제한, 품질 전환, 조명, 바퀴·부스트·드라이버 위치를 확인하고 기존 차량도 회귀 검증합니다.

필요하면 `node tools/qa/cornering-balance.mjs current`로 차종별 조향과 코스별 자동 주행을 비교합니다. 결과는 Git에서 제외된 `.cache/`에 저장됩니다. 이 수치와 `test/race-stability.test.js`의 자동 주행은 정해진 입력에 대한 지표이며, 실제 사람이 느끼는 밸런스를 보장하지 않습니다.

## 4. 실제 화면과 플레이

`npm start`로 실행해 새 차량을 선택하고 미리보기와 성능 수치, 연습 주행을 확인합니다. 가속·제동·후진·조향·드리프트·부스트·트랙 복귀와 벽·차량 충돌을 시험합니다. 고·중·저 품질, 주간과 야간에서 차체 교체, 바퀴 회전, 드라이버·조명·부스트가 자연스러운지 확인합니다.

가능하면 여러 브라우저 또는 실제 LAN의 서로 다른 PC에서 방 생성·참가, 차량 선택, 출발, 관전, 결과와 재경기를 확인합니다. 로컬 자동 검사, 같은 PC의 여러 브라우저, 서로 다른 실제 PC의 LAN 플레이는 서로 다른 검증입니다. 수행하지 않은 단계는 완료했다고 표시하지 않습니다.
