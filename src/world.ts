import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assetUrl, treeAssetPaths } from './data';
import type { CampusData, Point, PolygonData, TerrainData, TreeData, WorldStats } from './types';

interface Footprint {
  polygon: PolygonData;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  centerX: number;
  centerZ: number;
}

interface ClosestPoint {
  x: number;
  z: number;
  distance: number;
}

const UP = new THREE.Vector3(0, 1, 0);

function pointInPolygon(x: number, z: number, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    const intersects = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi || 1e-9) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function closestOnSegment(x: number, z: number, a: Point, b: Point): ClosestPoint {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared === 0 ? 0 : THREE.MathUtils.clamp(((x - a[0]) * dx + (z - a[1]) * dz) / lengthSquared, 0, 1);
  const px = a[0] + t * dx;
  const pz = a[1] + t * dz;
  return { x: px, z: pz, distance: Math.hypot(x - px, z - pz) };
}

function closestOnPolygon(x: number, z: number, polygon: Point[]): ClosestPoint {
  let closest: ClosestPoint = { x, z, distance: Number.POSITIVE_INFINITY };
  for (let i = 0; i < polygon.length; i += 1) {
    const candidate = closestOnSegment(x, z, polygon[i], polygon[(i + 1) % polygon.length]);
    if (candidate.distance < closest.distance) closest = candidate;
  }
  return closest;
}

function shapeFromPolygon(polygon: PolygonData): THREE.Shape | null {
  if (polygon.outer.length < 3) return null;
  const shape = new THREE.Shape();
  polygon.outer.forEach(([x, z], index) => {
    if (index === 0) shape.moveTo(x, -z);
    else shape.lineTo(x, -z);
  });
  shape.closePath();
  for (const holePoints of polygon.holes) {
    if (holePoints.length < 3) continue;
    const hole = new THREE.Path();
    holePoints.forEach(([x, z], index) => {
      if (index === 0) hole.moveTo(x, -z);
      else hole.lineTo(x, -z);
    });
    hole.closePath();
    shape.holes.push(hole);
  }
  return shape;
}

function usableTerrain(terrain: TerrainData | undefined): terrain is TerrainData {
  return Boolean(
    terrain &&
    Number.isInteger(terrain.rows) && terrain.rows >= 2 &&
    Number.isInteger(terrain.columns) && terrain.columns >= 2 &&
    Number.isFinite(terrain.minX) && Number.isFinite(terrain.maxX) && terrain.minX < terrain.maxX &&
    Number.isFinite(terrain.minZ) && Number.isFinite(terrain.maxZ) && terrain.minZ < terrain.maxZ &&
    Array.isArray(terrain.heights) && terrain.heights.length === terrain.rows * terrain.columns &&
    terrain.heights.every(Number.isFinite)
  );
}

function densifyPoints(points: Point[], maxSegmentLength: number): Point[] {
  const result: Point[] = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    const steps = Math.max(1, Math.ceil(Math.hypot(point[0] - previous[0], point[1] - previous[1]) / maxSegmentLength));
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      result.push([
        THREE.MathUtils.lerp(previous[0], point[0], t),
        THREE.MathUtils.lerp(previous[1], point[1], t),
      ]);
    }
  }
  return result;
}

function createRibbon(
  points: Point[],
  width: number,
  y: number,
  heightAt?: (x: number, z: number) => number,
): THREE.BufferGeometry | null {
  if (points.length < 2) return null;
  const positions: number[] = [];
  const indices: number[] = [];
  const halfWidth = Math.max(0.5, width) / 2;
  const ribbonPoints = heightAt ? densifyPoints(points, 8) : points;
  ribbonPoints.forEach((point, index) => {
    const previous = ribbonPoints[Math.max(0, index - 1)];
    const next = ribbonPoints[Math.min(ribbonPoints.length - 1, index + 1)];
    const dx = next[0] - previous[0];
    const dz = next[1] - previous[1];
    const length = Math.hypot(dx, dz) || 1;
    const nx = -dz / length;
    const nz = dx / length;
    const leftX = point[0] + nx * halfWidth;
    const leftZ = point[1] + nz * halfWidth;
    const rightX = point[0] - nx * halfWidth;
    const rightZ = point[1] - nz * halfWidth;
    positions.push(leftX, (heightAt?.(leftX, leftZ) ?? 0) + y, leftZ);
    positions.push(rightX, (heightAt?.(rightX, rightZ) ?? 0) + y, rightZ);
    if (index < ribbonPoints.length - 1) {
      const offset = index * 2;
      indices.push(offset, offset + 2, offset + 1, offset + 2, offset + 3, offset + 1);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createTerrainAreaGeometry(
  shape: THREE.Shape,
  heightAt: (x: number, z: number) => number,
  yOffset: number,
): THREE.BufferGeometry {
  const flatGeometry = new THREE.ShapeGeometry(shape);
  flatGeometry.rotateX(-Math.PI / 2);
  const source = flatGeometry.index ? flatGeometry.toNonIndexed() : flatGeometry;
  if (source !== flatGeometry) flatGeometry.dispose();
  const attribute = source.getAttribute('position');
  const positions: number[] = [];
  const maxEdgeLength = 10;

  const emitTriangle = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, depth: number): void => {
    const ab = Math.hypot(a.x - b.x, a.z - b.z);
    const bc = Math.hypot(b.x - c.x, b.z - c.z);
    const ca = Math.hypot(c.x - a.x, c.z - a.z);
    const longest = Math.max(ab, bc, ca);
    if (longest <= maxEdgeLength || depth >= 12) {
      for (const point of [a, b, c]) {
        positions.push(point.x, heightAt(point.x, point.z) + yOffset, point.z);
      }
      return;
    }
    if (longest === ab) {
      const midpoint = a.clone().add(b).multiplyScalar(0.5);
      emitTriangle(a, midpoint, c, depth + 1);
      emitTriangle(midpoint, b, c, depth + 1);
    } else if (longest === bc) {
      const midpoint = b.clone().add(c).multiplyScalar(0.5);
      emitTriangle(a, b, midpoint, depth + 1);
      emitTriangle(a, midpoint, c, depth + 1);
    } else {
      const midpoint = c.clone().add(a).multiplyScalar(0.5);
      emitTriangle(a, b, midpoint, depth + 1);
      emitTriangle(midpoint, b, c, depth + 1);
    }
  };

  for (let index = 0; index < attribute.count; index += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(attribute, index);
    const b = new THREE.Vector3().fromBufferAttribute(attribute, index + 1);
    const c = new THREE.Vector3().fromBufferAttribute(attribute, index + 2);
    emitTriangle(a, b, c, 0);
  }
  source.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function hashRotation(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0;
  return (Math.abs(hash) % 628) / 100;
}

export class CampusWorld {
  readonly scene = new THREE.Scene();
  readonly buildingMeshes: THREE.Mesh[] = [];
  readonly stats: WorldStats = { buildings: 0, trees: 0, fallbackTrees: 0 };
  private readonly root = new THREE.Group();
  private readonly terrain: TerrainData | null;
  private readonly footprints: Footprint[] = [];
  private readonly colliderGrid = new Map<string, number[]>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly sky: THREE.Mesh;
  private readonly sun: THREE.DirectionalLight;
  private readonly loader = new GLTFLoader();
  private disposed = false;

  constructor(readonly data: CampusData) {
    this.terrain = usableTerrain(data.terrain) ? data.terrain : null;
    this.scene.background = new THREE.Color(0xc4dce2);
    const size = Math.max(data.bounds.maxX - data.bounds.minX, data.bounds.maxZ - data.bounds.minZ);
    this.scene.fog = new THREE.FogExp2(0xd4e2df, Math.min(0.0022, 1.35 / Math.max(size, 500)));
    this.scene.add(this.root);

    const hemisphere = new THREE.HemisphereLight(0xc9edff, 0xb6a88c, 2.15);
    this.scene.add(hemisphere);
    this.sun = new THREE.DirectionalLight(0xffd6ae, 3.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -65;
    this.sun.shadow.camera.right = 65;
    this.sun.shadow.camera.top = 65;
    this.sun.shadow.camera.bottom = -65;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 240;
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.025;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target);

    this.sky = this.createSky(size);
    this.scene.add(this.sky);
    this.buildGround();
    this.buildAreas();
    this.buildRoads();
    this.buildBuildings();
    this.buildBoundary();
  }

  groundHeightAt(x: number, z: number): number {
    const terrain = this.terrain;
    if (!terrain) return 0;
    const column = THREE.MathUtils.clamp((x - terrain.minX) / (terrain.maxX - terrain.minX), 0, 1) * (terrain.columns - 1);
    const row = THREE.MathUtils.clamp((z - terrain.minZ) / (terrain.maxZ - terrain.minZ), 0, 1) * (terrain.rows - 1);
    const column0 = Math.floor(column);
    const row0 = Math.floor(row);
    const column1 = Math.min(column0 + 1, terrain.columns - 1);
    const row1 = Math.min(row0 + 1, terrain.rows - 1);
    const columnMix = column - column0;
    const rowMix = row - row0;
    const north = THREE.MathUtils.lerp(
      terrain.heights[row0 * terrain.columns + column0],
      terrain.heights[row0 * terrain.columns + column1],
      columnMix,
    );
    const south = THREE.MathUtils.lerp(
      terrain.heights[row1 * terrain.columns + column0],
      terrain.heights[row1 * terrain.columns + column1],
      columnMix,
    );
    return THREE.MathUtils.lerp(north, south, rowMix);
  }

  async buildTrees(): Promise<void> {
    const groups = new Map<string, TreeData[]>();
    for (const tree of this.data.trees) {
      const key = String(tree.variant ?? 'default');
      const group = groups.get(key) ?? [];
      group.push(tree);
      groups.set(key, group);
    }
    await Promise.all([...groups.entries()].map(async ([variant, trees]) => {
      try {
        const template = await this.loadTreeTemplate(variant);
        if (!this.disposed) this.createTreeInstances(template, trees, variant);
      } catch {
        if (!this.disposed) {
          this.createFallbackTrees(trees);
          this.stats.fallbackTrees += trees.length;
        }
      }
    }));
    this.stats.trees = this.data.trees.length;
  }

  private async loadTreeTemplate(variant: string): Promise<THREE.Group> {
    let lastError: unknown;
    for (const path of treeAssetPaths(variant)) {
      try {
        const gltf = await this.loader.loadAsync(assetUrl(path));
        gltf.scene.updateMatrixWorld(true);
        return gltf.scene;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('树木模型不可用');
  }

  private createTreeInstances(template: THREE.Group, trees: TreeData[], variant: string): void {
    const box = new THREE.Box3().setFromObject(template);
    if (box.isEmpty()) throw new Error('树木模型为空');
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const targetHeight = 5.8;
    const baseScale = targetHeight / Math.max(size.y, 0.01);
    const meshes: THREE.Mesh[] = [];
    template.traverse((object) => {
      if (object instanceof THREE.Mesh) meshes.push(object);
    });

    for (const sourceMesh of meshes) {
      const instances = new THREE.InstancedMesh(sourceMesh.geometry, sourceMesh.material, trees.length);
      instances.castShadow = true;
      instances.receiveShadow = true;
      instances.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      trees.forEach((tree, index) => {
        const scale = baseScale * (Number.isFinite(tree.scale) && tree.scale > 0 ? tree.scale : 1);
        const centering = new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z);
        const normalization = new THREE.Matrix4().makeScale(scale, scale, scale).multiply(centering);
        const placement = new THREE.Matrix4().compose(
          new THREE.Vector3(tree.position[0], this.groundHeightAt(tree.position[0], tree.position[1]), tree.position[1]),
          new THREE.Quaternion().setFromAxisAngle(UP, hashRotation(tree.id || `${variant}-${index}`)),
          new THREE.Vector3(1, 1, 1),
        );
        const matrix = placement.multiply(normalization).multiply(sourceMesh.matrixWorld);
        instances.setMatrixAt(index, matrix);
      });
      instances.instanceMatrix.needsUpdate = true;
      instances.computeBoundingSphere();
      this.root.add(instances);
    }
  }

  private createFallbackTrees(trees: TreeData[]): void {
    const trunkGeometry = new THREE.CylinderGeometry(0.2, 0.28, 2.4, 6);
    trunkGeometry.translate(0, 1.2, 0);
    const crownGeometry = new THREE.IcosahedronGeometry(1.75, 1);
    crownGeometry.scale(1, 1.15, 1);
    crownGeometry.translate(0, 3.55, 0);
    const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x8a6247, roughness: 1 });
    const crownMaterial = new THREE.MeshStandardMaterial({ color: 0x4c9872, roughness: 0.92 });
    const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, trees.length);
    const crowns = new THREE.InstancedMesh(crownGeometry, crownMaterial, trees.length);
    trunks.castShadow = true;
    crowns.castShadow = true;
    crowns.receiveShadow = true;
    trees.forEach((tree, index) => {
      const scale = Number.isFinite(tree.scale) && tree.scale > 0 ? tree.scale : 1;
      const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3(tree.position[0], this.groundHeightAt(tree.position[0], tree.position[1]), tree.position[1]),
        new THREE.Quaternion().setFromAxisAngle(UP, hashRotation(tree.id)),
        new THREE.Vector3(scale, scale, scale),
      );
      trunks.setMatrixAt(index, matrix);
      crowns.setMatrixAt(index, matrix);
    });
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    trunks.computeBoundingSphere();
    crowns.computeBoundingSphere();
    this.root.add(trunks, crowns);
  }

  private createSky(size: number): THREE.Mesh {
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x75afd2) },
        horizonColor: { value: new THREE.Color(0xffc6a3) },
        lowerColor: { value: new THREE.Color(0xe8f1e9) },
        sunDirection: { value: new THREE.Vector3(-0.55, 0.24, -0.8).normalize() },
      },
      vertexShader: `
        varying vec3 vDirection;
        void main() {
          vDirection = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vDirection;
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        uniform vec3 lowerColor;
        uniform vec3 sunDirection;
        void main() {
          float h = normalize(vDirection).y;
          vec3 color = h > 0.0
            ? mix(horizonColor, topColor, smoothstep(0.0, 0.72, h))
            : mix(horizonColor, lowerColor, smoothstep(0.0, -0.28, h));
          float sunGlow = pow(max(dot(normalize(vDirection), sunDirection), 0.0), 72.0);
          color += vec3(1.0, 0.62, 0.32) * sunGlow * 0.85;
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(Math.min(2200, Math.max(size * 1.5, 1200)), 32, 18), material);
    sky.frustumCulled = false;
    return sky;
  }

  private buildGround(): void {
    if (this.terrain) {
      this.buildTerrain(this.terrain);
      return;
    }
    const { minX, maxX, minZ, maxZ } = this.data.bounds;
    const width = maxX - minX;
    const depth = maxZ - minZ;
    const margin = Math.max(width, depth) * 0.3;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(width + margin * 2, depth + margin * 2),
      new THREE.MeshStandardMaterial({ color: 0xe5e7dc, roughness: 0.96, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((minX + maxX) / 2, -0.055, (minZ + maxZ) / 2);
    ground.receiveShadow = true;
    this.root.add(ground);

    const grid = new THREE.GridHelper(Math.max(width, depth) + margin, 42, 0xb6cbc6, 0xcbd6cf);
    grid.position.set((minX + maxX) / 2, -0.035, (minZ + maxZ) / 2);
    const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
    materials.forEach((material) => {
      material.transparent = true;
      material.opacity = 0.22;
      material.depthWrite = false;
    });
    this.root.add(grid);
  }

  private buildTerrain(terrain: TerrainData): void {
    const positions: number[] = [];
    const indices: number[] = [];
    for (let row = 0; row < terrain.rows; row += 1) {
      const z = THREE.MathUtils.lerp(terrain.minZ, terrain.maxZ, row / (terrain.rows - 1));
      for (let column = 0; column < terrain.columns; column += 1) {
        const x = THREE.MathUtils.lerp(terrain.minX, terrain.maxX, column / (terrain.columns - 1));
        positions.push(x, terrain.heights[row * terrain.columns + column], z);
        if (row < terrain.rows - 1 && column < terrain.columns - 1) {
          const a = row * terrain.columns + column;
          const b = a + terrain.columns;
          const c = a + 1;
          const d = b + 1;
          indices.push(a, b, c, b, d, c);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const ground = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0xe5e7dc, roughness: 0.96, metalness: 0 }),
    );
    ground.receiveShadow = true;
    this.root.add(ground);
  }

  private buildAreas(): void {
    const materials: Record<string, THREE.MeshStandardMaterial> = {
      water: new THREE.MeshPhysicalMaterial({
        color: 0x5cb8c9,
        roughness: 0.18,
        metalness: 0.05,
        transparent: true,
        opacity: 0.84,
        clearcoat: 0.65,
        clearcoatRoughness: 0.2,
      }),
      grass: new THREE.MeshStandardMaterial({ color: 0xaed2a7, roughness: 1 }),
      pedestrian: new THREE.MeshStandardMaterial({ color: 0xeee4d2, roughness: 0.94 }),
      wood: new THREE.MeshStandardMaterial({ color: 0xbd9675, roughness: 0.88 }),
    };
    const heightAt = this.terrain ? (x: number, z: number): number => this.groundHeightAt(x, z) : undefined;
    for (const area of this.data.areas) {
      if (heightAt && (area.kind === 'grass' || area.kind === 'wood')) continue;
      const material = materials[area.kind] ?? materials.grass;
      for (const polygon of area.polygons) {
        const shape = shapeFromPolygon(polygon);
        if (!shape) continue;
        const yOffset = area.kind === 'water' ? 0.005 : 0.015;
        const geometry = heightAt
          ? createTerrainAreaGeometry(shape, heightAt, yOffset)
          : new THREE.ShapeGeometry(shape);
        const mesh = new THREE.Mesh(geometry, material);
        if (!heightAt) {
          mesh.rotation.x = -Math.PI / 2;
          mesh.position.y = yOffset;
        }
        mesh.receiveShadow = true;
        this.root.add(mesh);
      }
    }
  }

  private buildRoads(): void {
    const materials = new Map<string, THREE.MeshStandardMaterial>();
    const heightAt = this.terrain ? (x: number, z: number): number => this.groundHeightAt(x, z) : undefined;
    for (const road of this.data.roads) {
      const key = road.kind || 'road';
      let material = materials.get(key);
      if (!material) {
        const pedestrian = /path|foot|pedestrian|cycle/i.test(key);
        material = new THREE.MeshStandardMaterial({
          color: pedestrian ? 0xd8d5c9 : 0x9da9aa,
          roughness: 0.9,
          polygonOffset: true,
          polygonOffsetFactor: -1,
        });
        materials.set(key, material);
      }
      const y = 0.035 + Math.max(0, road.layer || 0) * 0.08;
      const geometry = createRibbon(road.points, road.width, y, heightAt);
      if (!geometry) continue;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }
  }

  private buildBuildings(): void {
    const wallMaterials = new Map<string, THREE.MeshStandardMaterial>();
    for (const building of this.data.buildings) {
      let material = wallMaterials.get(building.kind);
      if (!material) {
        const accent = /sport|hall|library|landmark/i.test(building.kind);
        material = new THREE.MeshStandardMaterial({
          color: accent ? 0xf4eee0 : 0xf2f0e7,
          roughness: 0.72,
          metalness: 0.015,
        });
        wallMaterials.set(building.kind, material);
      }
      for (const polygon of building.polygons) {
        const shape = shapeFromPolygon(polygon);
        if (!shape) continue;
        const height = Number.isFinite(building.height) ? THREE.MathUtils.clamp(building.height, 2.5, 160) : 8;
        const geometry = new THREE.ExtrudeGeometry(shape, {
          depth: height,
          bevelEnabled: true,
          bevelSegments: 1,
          bevelSize: 0.07,
          bevelThickness: 0.07,
          curveSegments: 2,
        });
        geometry.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.y = this.buildingBaseHeight(polygon);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.buildingName = building.name;
        this.root.add(mesh);
        this.buildingMeshes.push(mesh);
        this.addFootprint(polygon);
        this.stats.buildings += 1;
      }
    }
  }

  private buildingBaseHeight(polygon: PolygonData): number {
    if (!this.terrain) return 0;
    const points = polygon.outer;
    const xs = points.map((point) => point[0]);
    const zs = points.map((point) => point[1]);
    let lowest = this.groundHeightAt((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2);
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const next = points[(index + 1) % points.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(next[0] - point[0], next[1] - point[1]) / 8));
      for (let step = 0; step < steps; step += 1) {
        const t = step / steps;
        lowest = Math.min(lowest, this.groundHeightAt(
          THREE.MathUtils.lerp(point[0], next[0], t),
          THREE.MathUtils.lerp(point[1], next[1], t),
        ));
      }
    }
    return lowest - 0.16;
  }

  private addFootprint(polygon: PolygonData): void {
    const points = polygon.outer;
    const xs = points.map((point) => point[0]);
    const zs = points.map((point) => point[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const footprint = {
      polygon,
      minX,
      maxX,
      minZ,
      maxZ,
      centerX: (minX + maxX) / 2,
      centerZ: (minZ + maxZ) / 2,
    };
    const index = this.footprints.push(footprint) - 1;
    const cellSize = 32;
    for (let x = Math.floor(minX / cellSize); x <= Math.floor(maxX / cellSize); x += 1) {
      for (let z = Math.floor(minZ / cellSize); z <= Math.floor(maxZ / cellSize); z += 1) {
        const key = `${x},${z}`;
        const entries = this.colliderGrid.get(key) ?? [];
        entries.push(index);
        this.colliderGrid.set(key, entries);
      }
    }
  }

  private buildBoundary(): void {
    if (this.data.campus.length < 2) return;
    const outline = this.terrain
      ? densifyPoints([...this.data.campus, this.data.campus[0]], 8)
      : this.data.campus;
    const points = outline.map(([x, z]) => new THREE.Vector3(x, this.groundHeightAt(x, z) + 0.09, z));
    if (!this.terrain) points.push(points[0].clone());
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: 0x65bec1, transparent: true, opacity: 0.48 }),
    );
    this.root.add(line);
  }

  resolveCollisions(x: number, z: number, radius = 0.38): { x: number; z: number } {
    let px = x;
    let pz = z;
    const cellSize = 32;
    const nearby = new Set<number>();
    for (let cx = Math.floor((px - radius) / cellSize); cx <= Math.floor((px + radius) / cellSize); cx += 1) {
      for (let cz = Math.floor((pz - radius) / cellSize); cz <= Math.floor((pz + radius) / cellSize); cz += 1) {
        for (const index of this.colliderGrid.get(`${cx},${cz}`) ?? []) nearby.add(index);
      }
    }
    for (let iteration = 0; iteration < 3; iteration += 1) {
      for (const index of nearby) {
        const footprint = this.footprints[index];
        if (px < footprint.minX - radius || px > footprint.maxX + radius || pz < footprint.minZ - radius || pz > footprint.maxZ + radius) continue;
        const polygons = [footprint.polygon.outer, ...footprint.polygon.holes];
        const inOuter = pointInPolygon(px, pz, footprint.polygon.outer);
        const inHole = footprint.polygon.holes.some((hole) => pointInPolygon(px, pz, hole));
        const insideSolid = inOuter && !inHole;
        let closest: ClosestPoint = { x: px, z: pz, distance: Number.POSITIVE_INFINITY };
        for (const polygon of polygons) {
          const candidate = closestOnPolygon(px, pz, polygon);
          if (candidate.distance < closest.distance) closest = candidate;
        }
        if (!insideSolid && closest.distance >= radius) continue;
        let dx = px - closest.x;
        let dz = pz - closest.z;
        let distance = Math.hypot(dx, dz);
        if (insideSolid && distance > radius) {
          dx = px - footprint.centerX;
          dz = pz - footprint.centerZ;
          distance = Math.hypot(dx, dz) || 1;
          px = closest.x + (dx / distance) * radius;
          pz = closest.z + (dz / distance) * radius;
        } else {
          if (distance < 1e-6) {
            dx = px - footprint.centerX;
            dz = pz - footprint.centerZ;
            distance = Math.hypot(dx, dz) || 1;
          }
          const push = radius - closest.distance + 0.002;
          px += (dx / distance) * push;
          pz += (dz / distance) * push;
        }
      }
    }
    return this.constrainToCampus(px, pz, radius);
  }

  constrainToCampus(x: number, z: number, margin = 0.4): { x: number; z: number } {
    const bounds = this.data.bounds;
    let px = THREE.MathUtils.clamp(x, bounds.minX + margin, bounds.maxX - margin);
    let pz = THREE.MathUtils.clamp(z, bounds.minZ + margin, bounds.maxZ - margin);
    if (this.data.campus.length >= 3 && !pointInPolygon(px, pz, this.data.campus)) {
      const closest = closestOnPolygon(px, pz, this.data.campus);
      const centerX = (bounds.minX + bounds.maxX) / 2;
      const centerZ = (bounds.minZ + bounds.maxZ) / 2;
      const dx = centerX - closest.x;
      const dz = centerZ - closest.z;
      const length = Math.hypot(dx, dz) || 1;
      px = closest.x + (dx / length) * (margin + 0.05);
      pz = closest.z + (dz / length) * (margin + 0.05);
    }
    return { x: px, z: pz };
  }

  clipCamera(target: THREE.Vector3, desired: THREE.Vector3): THREE.Vector3 {
    const direction = desired.clone().sub(target);
    const distance = direction.length();
    if (distance < 0.01) return desired;
    direction.normalize();
    this.raycaster.set(target, direction);
    this.raycaster.far = distance;
    const hit = this.raycaster.intersectObjects(this.buildingMeshes, false)[0];
    if (!hit) return desired;
    return target.clone().addScaledVector(direction, Math.max(0.55, hit.distance - 0.28));
  }

  updateFocus(position: THREE.Vector3, camera: THREE.Camera): void {
    this.sky.position.copy(camera.position);
    this.sun.position.set(position.x - 65, 105, position.z - 45);
    this.sun.target.position.set(position.x, 0, position.z);
    this.sun.target.updateMatrixWorld();
  }

  dispose(): void {
    this.disposed = true;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.GridHelper) {
        geometries.add(object.geometry);
        const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
        objectMaterials.forEach((material) => materials.add(material));
      }
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this.scene.clear();
    this.buildingMeshes.length = 0;
    this.footprints.length = 0;
    this.colliderGrid.clear();
  }
}
