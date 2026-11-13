import * as THREE from 'three';
import { BlockAvatar } from './avatar';
import type { CampusWorld } from './world';

export class RoamingController {
  readonly avatar = new BlockAvatar();
  private readonly keys = new Set<string>();
  private readonly velocity = new THREE.Vector3();
  private verticalVelocity = 0;
  private grounded = true;
  private yaw = 0.35;
  private pitch = 0.32;
  private world: CampusWorld;
  private playing = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
    world: CampusWorld,
    private readonly onPlayingChange: (playing: boolean) => void,
    private readonly onPointerError: () => void,
  ) {
    this.world = world;
    this.camera.near = 0.08;
    this.camera.far = 3200;
    this.camera.updateProjectionMatrix();
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('pointerlockerror', this.onPointerError);
    window.addEventListener('blur', this.clearKeys);
    this.reset(true);
  }

  setWorld(world: CampusWorld): void {
    this.world = world;
    this.reset(true);
  }

  async requestPlaying(): Promise<void> {
    try {
      await this.canvas.requestPointerLock();
    } catch {
      this.onPointerError();
    }
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.playing) return;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'Space', 'KeyR'].includes(event.code)) {
      event.preventDefault();
    }
    if (event.code === 'KeyR') {
      this.reset(true);
      return;
    }
    if (event.code === 'Space' && this.grounded && !event.repeat) {
      this.verticalVelocity = 7.2;
      this.grounded = false;
    }
    this.keys.add(event.code);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.playing) return;
    this.yaw -= event.movementX * 0.0022;
    this.pitch = THREE.MathUtils.clamp(this.pitch + event.movementY * 0.0018, -0.08, 1.05);
  };

  private onPointerLockChange = (): void => {
    this.playing = document.pointerLockElement === this.canvas;
    if (!this.playing) this.clearKeys();
    this.onPlayingChange(this.playing);
  };

  private clearKeys = (): void => {
    this.keys.clear();
  };

  reset(snapCamera = false): void {
    const spawn = this.world.resolveCollisions(this.world.data.spawn[0], this.world.data.spawn[1]);
    this.avatar.group.position.set(spawn.x, this.world.groundHeightAt(spawn.x, spawn.z), spawn.z);
    this.avatar.group.rotation.y = 0;
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
    this.grounded = true;
    this.yaw = 0.35;
    this.pitch = 0.32;
    this.updateCamera(1, snapCamera);
  }

  update(delta: number): void {
    const forwardInput = Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS'));
    const rightInput = Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA'));
    const inputLength = Math.hypot(forwardInput, rightInput);
    const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = sprinting ? 8.2 : 4.6;
    const targetVelocity = new THREE.Vector3();
    if (this.playing && inputLength > 0) {
      const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      targetVelocity.addScaledVector(forward, forwardInput).addScaledVector(right, rightInput).normalize().multiplyScalar(speed);
      this.avatar.faceDirection(targetVelocity.x, targetVelocity.z, delta);
    }
    const response = 1 - Math.exp(-delta * (inputLength > 0 ? 12 : 9));
    this.velocity.lerp(targetVelocity, response);

    const position = this.avatar.group.position;
    const resolved = this.world.resolveCollisions(position.x + this.velocity.x * delta, position.z + this.velocity.z * delta);
    if (Math.abs(resolved.x - (position.x + this.velocity.x * delta)) > 0.03) this.velocity.x *= 0.25;
    if (Math.abs(resolved.z - (position.z + this.velocity.z * delta)) > 0.03) this.velocity.z *= 0.25;
    position.x = resolved.x;
    position.z = resolved.z;

    const groundHeight = this.world.groundHeightAt(position.x, position.z);
    if (this.grounded) {
      position.y = groundHeight;
      this.verticalVelocity = 0;
    } else {
      this.verticalVelocity -= 20.5 * delta;
      position.y += this.verticalVelocity * delta;
      if (position.y <= groundHeight) {
        position.y = groundHeight;
        this.verticalVelocity = 0;
        this.grounded = true;
      }
    }
    const horizontalSpeed = this.playing ? this.velocity.length() : 0;
    this.avatar.update(delta, horizontalSpeed, this.grounded);
    this.updateCamera(delta, false);
  }

  private updateCamera(delta: number, snap: boolean): void {
    const target = this.avatar.group.position.clone().add(new THREE.Vector3(0, 1.55, 0));
    const distance = 7.4;
    const horizontal = Math.cos(this.pitch) * distance;
    const desired = new THREE.Vector3(
      target.x + Math.sin(this.yaw) * horizontal,
      target.y + Math.sin(this.pitch) * distance + 0.35,
      target.z + Math.cos(this.yaw) * horizontal,
    );
    const clipped = this.world.clipCamera(target, desired);
    if (snap) this.camera.position.copy(clipped);
    else {
      const smoothed = this.camera.position.clone().lerp(clipped, 1 - Math.exp(-delta * 13));
      this.camera.position.copy(this.world.clipCamera(target, smoothed));
    }
    const cameraFloor = this.world.groundHeightAt(this.camera.position.x, this.camera.position.z) + 0.3;
    this.camera.position.y = Math.max(this.camera.position.y, cameraFloor);
    this.camera.lookAt(target);
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('pointerlockerror', this.onPointerError);
    window.removeEventListener('blur', this.clearKeys);
  }
}
