const OCEAN_SHADER = {
  uniforms: {
    worldTime: {
      type: 'f',
      value: 0,
    },
  },
  vertexShader: [
    "uniform float worldTime;",
    "attribute vec4 wave;",
    "void main() {",
    "  float y = wave[0];",
    "  float ang = wave[1];",
    "  float amp = wave[2];",
    "  float speed = wave[3];",
    "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.x, y + ((sin(ang + (speed * worldTime))) * amp), position.z, 1.0);",
    "}"
  ].join("\n"),
  fragmentShader: [
    "void main() {",
    "  gl_FragColor = vec4(0.2, 0.2, 0.2, 0.25);",
    "}"
  ].join("\n")
};

const DATA = {
  amplitude: 0.1,
  amplitudeVariance: 0.3,
  speed: 1,
  speedVariance: 2,
};

class Ocean {
  constructor(archae) {
    this._archae = archae;
  }

  mount() {
    const {_archae: archae} = this;
    this._cleanup = () => {};

    return archae.requestEngines([
      '/core/engines/zeo',
      '/core/engines/rend',
    ]).then(([
      zeo,
      rend,
    ]) => {
      const {THREE, scene} = zeo;
      const world = rend.getCurrentWorld();

      const updates = [];
      const _update = () => {
        for (let i = 0; i < updates.length; i++) {
          const update = updates[i];
          update();
        }
      };

      return {
        update: _update,
        elements: [
          class OceanElement extends HTMLElement {
            static get tag() {
              return 'ocean';
            }
            static get attributes() {
              return {
                position: {
                  type: 'matrix',
                  value: [
                    0, 0, 0,
                    0, 0, 0, 1,
                    1, 1, 1,
                  ],
                },
              };
            }

            createdCallback() {
              const mesh = (() => {
                const geometry = new THREE.PlaneBufferGeometry(200, 200, 200 / 2, 200 / 2);
                geometry.applyMatrix(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
                geometry.applyMatrix(new THREE.Matrix4().makeTranslation(0, 0, 0));
                const waves = (() => {
                  const positions = geometry.getAttribute('position').array;
                  const numPositions = positions.length / 3;

                  const result = new Float32Array(numPositions * 4);
                  for (let i = 0; i < numPositions; i++) {
                    const y = positions[(i * 3) + 1];

                    const baseIndex = i * 4;
                    result[baseIndex + 0] = y; // y
                    result[baseIndex + 1] = Math.random() * Math.PI * 2; // ang
                    result[baseIndex + 2] = DATA.amplitude + Math.random() * DATA.amplitudeVariance; // amp
                    result[baseIndex + 3] = (DATA.speed + Math.random() * DATA.speedVariance) / 1000; // speed
                  }
                  return result;
                })();
                geometry.addAttribute('wave', new THREE.BufferAttribute(waves, 4));

                /* const material = new THREE.MeshBasicMaterial({
                  color: 0x000000,
                  wireframe: true,
                  opacity: 0.25,
                  transparent: true,
                }); */
                const uniforms = THREE.UniformsUtils.clone(OCEAN_SHADER.uniforms);
                const material = new THREE.ShaderMaterial({
                  uniforms,
                  vertexShader: OCEAN_SHADER.vertexShader,
                  fragmentShader: OCEAN_SHADER.fragmentShader,
                  wireframe: true,
                  // opacity: 0.25,
                  transparent: true,
                });

                const result = new THREE.Mesh(geometry, material);
                result.renderOrder = -1;
                return result;
              })();
              scene.add(mesh);
              this.mesh = mesh;

              const {material: meshMaterial} = mesh;
              const update = () => {
                const worldTime = world.getWorldTime();
                meshMaterial.uniforms.worldTime.value = worldTime;
              };
              updates.push(update);
            
              this._cleanup = () => {
                scene.remove(mesh);

                updates.splice(updates.indexOf(update), 1);
              };
            }

            destructor() {
              this._cleanup();
            }

            attributeChangedCallback(name, oldValue, newValue) {
              const value = JSON.parse(newValue);

              switch (name) {
                case 'position': {
                  const {mesh} = this;

                  mesh.position.set(value[0], value[1], value[2]);
                  mesh.quaternion.set(value[3], value[4], value[5], value[6]);
                  mesh.scale.set(value[7], value[8], value[9]);

                  break;
                }
              }
            }
          }
        ],
        templates: [
          {
            tag: 'ocean',
            attributes: {},
            children: [],
          },
        ],
      };
    });
  }

  unmount() {
    this._cleanup();
  }
}

module.exports = Ocean;
