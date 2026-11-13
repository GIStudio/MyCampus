import * as THREE from 'three';

export class BlockAvatar {
  readonly group = new THREE.Group();
  private readonly leftArm: THREE.Group;
  private readonly rightArm: THREE.Group;
  private readonly leftLeg: THREE.Group;
  private readonly rightLeg: THREE.Group;
  private walkPhase = 0;

  constructor() {
    const skin = new THREE.MeshStandardMaterial({ color: 0xf1b78f, roughness: 0.82 });
    const shirt = new THREE.MeshStandardMaterial({ color: 0x168da2, roughness: 0.72 });
    const shirtLight = new THREE.MeshStandardMaterial({ color: 0x62d5d5, roughness: 0.72 });
    const trousers = new THREE.MeshStandardMaterial({ color: 0x18364d, roughness: 0.85 });
    const shoes = new THREE.MeshStandardMaterial({ color: 0xf3f0e8, roughness: 0.9 });
    const hair = new THREE.MeshStandardMaterial({ color: 0x292d35, roughness: 0.95 });
    const face = new THREE.MeshBasicMaterial({ color: 0x24313b });

    const body = this.box(0.72, 0.86, 0.4, shirt);
    body.position.y = 1.18;
    this.group.add(body);

    const shirtStripe = this.box(0.74, 0.12, 0.415, shirtLight);
    shirtStripe.position.y = 1.27;
    this.group.add(shirtStripe);

    const head = this.box(0.64, 0.64, 0.64, skin);
    head.position.y = 1.94;
    this.group.add(head);

    const hairTop = this.box(0.66, 0.14, 0.66, hair);
    hairTop.position.y = 2.23;
    this.group.add(hairTop);
    const hairBack = this.box(0.66, 0.4, 0.08, hair);
    hairBack.position.set(0, 2.04, -0.32);
    this.group.add(hairBack);

    for (const x of [-0.15, 0.15]) {
      const eye = this.box(0.09, 0.1, 0.018, face);
      eye.position.set(x, 2.01, 0.329);
      this.group.add(eye);
    }
    const mouth = this.box(0.18, 0.055, 0.018, face);
    mouth.position.set(0, 1.8, 0.329);
    this.group.add(mouth);

    this.leftArm = this.limb(-0.51, 1.57, 0.25, 0.78, 0.3, shirt, skin);
    this.rightArm = this.limb(0.51, 1.57, 0.25, 0.78, 0.3, shirt, skin);
    this.leftLeg = this.limb(-0.19, 0.76, 0.29, 0.7, 0.33, trousers, shoes);
    this.rightLeg = this.limb(0.19, 0.76, 0.29, 0.7, 0.33, trousers, shoes);
    this.group.add(this.leftArm, this.rightArm, this.leftLeg, this.rightLeg);

    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
  }

  private box(width: number, height: number, depth: number, material: THREE.Material): THREE.Mesh {
    return new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  }

  private limb(
    x: number,
    y: number,
    width: number,
    length: number,
    depth: number,
    material: THREE.Material,
    endMaterial: THREE.Material,
  ): THREE.Group {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const segment = this.box(width, length, depth, material);
    segment.position.y = -length / 2;
    const end = this.box(width + 0.015, 0.18, depth + 0.02, endMaterial);
    end.position.y = -length + 0.09;
    pivot.add(segment, end);
    return pivot;
  }

  update(delta: number, speed: number, grounded: boolean): void {
    const intensity = Math.min(speed / 5, 1);
    this.walkPhase += delta * (4 + speed * 1.25);
    const swing = grounded ? Math.sin(this.walkPhase) * 0.72 * intensity : 0.28;
    this.leftArm.rotation.x = swing;
    this.rightArm.rotation.x = -swing;
    this.leftLeg.rotation.x = -swing * 0.78;
    this.rightLeg.rotation.x = swing * 0.78;
  }

  faceDirection(x: number, z: number, delta: number): void {
    const target = Math.atan2(x, z);
    let difference = target - this.group.rotation.y;
    difference = Math.atan2(Math.sin(difference), Math.cos(difference));
    this.group.rotation.y += difference * (1 - Math.exp(-delta * 14));
  }
}
