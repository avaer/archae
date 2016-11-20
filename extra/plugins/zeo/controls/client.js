const POSITION_SPEED = 0.02;
const ROTATION_SPEED = 0.02 / (Math.PI * 2);

const controls = archae => ({
  mount() {
    return archae.requestEngines([
      '/core/engines/zeo',
    ])
      .then(([
        zeo,
      ]) => {
        const {THREE, camera, renderer} = zeo;

        const keys = {
          up: false,
          down: false,
          left: false,
          right: false,
        };
        this.keys = keys;

        const _resetKeys = () => {
          keys.up = false;
          keys.down = false;
          keys.left = false;
          keys.right = false;
        };

        const click = () => {
          renderer.domElement.requestPointerLock();
        };
        const pointerlockchange = e => {
          if (!window.document.pointerLockElement) {
            _resetKeys();
          }
        };
        const pointerlockerror = e => {
          _resetKeys();

          console.warn('pointer lock error', e);
        };
        const mousemove = e => {
          if (window.document.pointerLockElement) {
            const {movementX, movementY} = e;

            camera.rotation.x += (-movementY * ROTATION_SPEED);
            camera.rotation.y += (-movementX * ROTATION_SPEED);
          }
        };
        const keydown = e => {
          if (window.document.pointerLockElement) {
            switch (e.keyCode) {
              case 87: // W
                keys.up = true;
                break;
              case 65: // A
                keys.left = true;
                break;
              case 83: // S
                keys.down = true;
                break;
              case 68: // D
                keys.right = true;
                break;
            }
          }
        };
        const keyup = e => {
          if (window.document.pointerLockElement) {
            switch (e.keyCode) {
              case 87: // W
                keys.up = false;
                break;
              case 65: // A
                keys.left = false;
                break;
              case 83: // S
                keys.down = false;
                break;
              case 68: // D
                keys.right = false;
                break;
            }
          }
        };
        renderer.domElement.addEventListener('click', click);
        window.document.addEventListener('pointerlockchange', pointerlockchange);
        window.document.addEventListener('pointerlockerror', pointerlockerror);
        window.addEventListener('mousemove', mousemove);
        window.addEventListener('keydown', keydown);
        window.addEventListener('keyup', keyup);

        const _update = () => {
          const {keys} = this;

          const moveVector = new THREE.Vector3();
          if (keys.up) {
            moveVector.z -= POSITION_SPEED;
          }
          if (keys.down) {
            moveVector.z += POSITION_SPEED;
          }
          if (keys.left) {
            moveVector.x -= POSITION_SPEED;
          }
          if (keys.right) {
            moveVector.x += POSITION_SPEED;
          }

          moveVector.applyQuaternion(camera.quaternion);

          camera.position.x += moveVector.x;
          camera.position.z += moveVector.z;
          camera.position.y += moveVector.y;
        };

        this._cleanup = () => {
          renderer.domElement.removeEventListener('click', click);
          window.document.removeEventListener('pointerlockchange', pointerlockchange);
          window.document.removeEventListener('pointerlockerror', pointerlockerror);
          window.removeEventListener('mousemove', mousemove);
          window.removeEventListener('keydown', keydown);
          window.removeEventListener('keyup', keyup);
        };

        return {
          update: _update,
        };
      });
  },
  unmount() {
    this._cleanup();
  },
});

module.exports = controls;
