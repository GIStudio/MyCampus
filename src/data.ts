import type { CampusData, CampusDefinition, Point } from './types';

export const CAMPUSES: CampusDefinition[] = [
  {
    id: 'clear-water-bay',
    name: '香港科技大学（清水湾）',
    shortName: '清水湾',
    dataPaths: ['data/clear-water-bay.json'],
  },
  {
    id: 'guangzhou',
    name: '香港科技大学（广州）',
    shortName: '广州',
    dataPaths: ['data/guangzhou.json', 'data/hkust-gz.json'],
  },
];

export function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`;
}

function isPoint(value: unknown): value is Point {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]);
}

function validateCampus(value: unknown, expectedId: string): CampusData {
  if (!value || typeof value !== 'object') throw new Error('校园数据格式无效');
  const campus = value as Partial<CampusData>;
  const bounds = campus.bounds;
  if (
    typeof campus.id !== 'string' ||
    typeof campus.name !== 'string' ||
    !bounds ||
    !Number.isFinite(bounds.minX) ||
    !Number.isFinite(bounds.maxX) ||
    !Number.isFinite(bounds.minZ) ||
    !Number.isFinite(bounds.maxZ) ||
    !Array.isArray(campus.campus) ||
    !campus.campus.every(isPoint) ||
    !Array.isArray(campus.buildings) ||
    !Array.isArray(campus.roads) ||
    !Array.isArray(campus.areas) ||
    !Array.isArray(campus.trees) ||
    !isPoint(campus.spawn)
  ) {
    throw new Error('校园数据缺少必要字段或坐标无效');
  }
  if (bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ) {
    throw new Error('校园边界范围无效');
  }
  if (campus.id !== expectedId) {
    return { ...campus, id: expectedId } as CampusData;
  }
  return campus as CampusData;
}

export async function loadCampus(definition: CampusDefinition, signal?: AbortSignal): Promise<CampusData> {
  const errors: string[] = [];
  for (const path of definition.dataPaths) {
    try {
      const response = await fetch(assetUrl(path), { signal, cache: 'no-cache' });
      if (!response.ok) {
        errors.push(`${path}: HTTP ${response.status}`);
        continue;
      }
      return validateCampus(await response.json(), definition.id);
    } catch (error) {
      if (signal?.aborted) throw error;
      errors.push(`${path}: ${error instanceof Error ? error.message : '读取失败'}`);
    }
  }
  throw new Error(`无法读取${definition.shortName}校区数据（${errors.join('；')}）`);
}

export function treeAssetPaths(variant: string | number): string[] {
  const raw = String(variant ?? 'default');
  const safe = encodeURIComponent(raw.replace(/\.glb$/i, ''));
  return [...new Set([
    `assets/trees/tree-${safe}.glb`,
    `assets/trees/${safe}.glb`,
    `assets/trees/tree_${safe}.glb`,
    'assets/trees/tree.glb',
  ])];
}
