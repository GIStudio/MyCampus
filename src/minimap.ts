import type { CampusData, Point, PolygonData } from './types';

const SIZE = 232;
const PADDING = 16;

export class CampusMinimap {
  private readonly context: CanvasRenderingContext2D;
  private readonly staticMap = document.createElement('canvas');
  private data: CampusData | null = null;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private pixelRatio = 1;
  private width = SIZE;
  private height = SIZE;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法初始化小地图');
    this.context = context;
    this.resize();
  }

  resize(): void {
    const bounds = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, Math.round(bounds.width || SIZE));
    this.height = Math.max(1, Math.round(bounds.height || SIZE));
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.pixelRatio);
    this.canvas.height = Math.round(this.height * this.pixelRatio);
    this.staticMap.width = this.canvas.width;
    this.staticMap.height = this.canvas.height;
    if (this.data) {
      this.updateProjection();
      this.renderStatic();
    }
  }

  setData(data: CampusData): void {
    this.data = data;
    this.updateProjection();
    this.renderStatic();
  }

  private updateProjection(): void {
    if (!this.data) return;
    const width = this.data.bounds.maxX - this.data.bounds.minX;
    const depth = this.data.bounds.maxZ - this.data.bounds.minZ;
    this.scale = Math.min((this.width - PADDING * 2) / width, (this.height - PADDING * 2) / depth);
    this.offsetX = (this.width - width * this.scale) / 2 - this.data.bounds.minX * this.scale;
    this.offsetY = (this.height - depth * this.scale) / 2 + this.data.bounds.maxZ * this.scale;
  }

  private project([x, z]: Point): Point {
    return [x * this.scale + this.offsetX, this.offsetY - z * this.scale];
  }

  private tracePolygon(context: CanvasRenderingContext2D, polygon: PolygonData): void {
    context.beginPath();
    for (const points of [polygon.outer, ...polygon.holes]) {
      points.forEach((point, index) => {
        const [x, y] = this.project(point);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.closePath();
    }
  }

  private renderStatic(): void {
    if (!this.data) return;
    const context = this.staticMap.getContext('2d');
    if (!context) return;
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    context.clearRect(0, 0, this.width, this.height);
    context.fillStyle = '#edf0e8';
    context.fillRect(0, 0, this.width, this.height);

    for (const area of this.data.areas) {
      context.fillStyle = area.kind === 'water'
        ? '#83c8d2'
        : area.kind === 'grass'
          ? '#c0d9b5'
          : area.kind === 'wood'
            ? '#cbb292'
            : '#e4ddce';
      for (const polygon of area.polygons) {
        this.tracePolygon(context, polygon);
        context.fill('evenodd');
      }
    }

    context.lineCap = 'round';
    context.lineJoin = 'round';
    for (const road of this.data.roads) {
      if (road.points.length < 2) continue;
      context.beginPath();
      road.points.forEach((point, index) => {
        const [x, y] = this.project(point);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.strokeStyle = /path|foot|pedestrian|cycle/i.test(road.kind) ? '#f6f2e9' : '#b3bcb9';
      context.lineWidth = Math.max(1.2, Math.min(5, road.width * this.scale));
      context.stroke();
    }

    context.fillStyle = '#f9f7ef';
    context.strokeStyle = '#c9cdc3';
    context.lineWidth = 0.65;
    for (const building of this.data.buildings) {
      for (const polygon of building.polygons) {
        this.tracePolygon(context, polygon);
        context.fill('evenodd');
        context.stroke();
      }
    }

    context.fillStyle = '#579273';
    for (const tree of this.data.trees) {
      const [x, y] = this.project(tree.position);
      context.beginPath();
      context.arc(x, y, 0.85, 0, Math.PI * 2);
      context.fill();
    }

    if (this.data.campus.length > 1) {
      context.beginPath();
      this.data.campus.forEach((point, index) => {
        const [x, y] = this.project(point);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.closePath();
      context.strokeStyle = '#57aeb4';
      context.lineWidth = 1.2;
      context.stroke();
    }
  }

  update(x: number, z: number, rotation: number): void {
    if (!this.data) {
      this.context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
      this.context.clearRect(0, 0, this.width, this.height);
      return;
    }
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.drawImage(this.staticMap, 0, 0);
    this.context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    const [px, py] = this.project([x, z]);
    this.context.save();
    this.context.translate(px, py);
    this.context.rotate(-rotation);
    this.context.beginPath();
    this.context.moveTo(0, -7);
    this.context.lineTo(5, 5);
    this.context.lineTo(0, 3);
    this.context.lineTo(-5, 5);
    this.context.closePath();
    this.context.fillStyle = '#087f91';
    this.context.fill();
    this.context.strokeStyle = '#ffffff';
    this.context.lineWidth = 1.8;
    this.context.stroke();
    this.context.restore();
  }
}
