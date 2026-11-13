export type Point = [number, number];

export interface PolygonData {
  outer: Point[];
  holes: Point[][];
}

export interface BuildingData {
  id: string;
  name: string;
  kind: string;
  height: number;
  heightSource: string;
  polygons: PolygonData[];
}

export interface RoadData {
  id: string;
  name: string;
  kind: string;
  width: number;
  layer: number;
  points: Point[];
}

export interface AreaData {
  id: string;
  kind: 'water' | 'grass' | 'pedestrian' | 'wood' | string;
  polygons: PolygonData[];
}

export interface TreeData {
  id: string;
  position: Point;
  source: string;
  variant: string | number;
  scale: number;
}

export interface CampusData {
  id: string;
  name: string;
  shortName: string;
  origin: unknown;
  bbox: unknown;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  campus: Point[];
  buildings: BuildingData[];
  roads: RoadData[];
  areas: AreaData[];
  trees: TreeData[];
  spawn: Point;
  meta: unknown;
}

export interface CampusDefinition {
  id: string;
  name: string;
  shortName: string;
  dataPaths: string[];
}

export interface CollisionResult {
  position: { x: number; z: number };
  collided: boolean;
}

export interface WorldStats {
  buildings: number;
  trees: number;
  fallbackTrees: number;
}
