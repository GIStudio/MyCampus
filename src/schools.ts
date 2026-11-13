import { CAMPUSES, clearCampusCache } from './data';
import type { CampusDefinition } from './types';

const CUSTOM_SCHOOLS_KEY = 'mycampus.schools.v1';

export function getCustomSchools(): CampusDefinition[] {
  try {
    const value = JSON.parse(localStorage.getItem(CUSTOM_SCHOOLS_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((school) => (
      typeof school?.id === 'string' && school.id.startsWith('custom-') &&
      typeof school.name === 'string' && typeof school.shortName === 'string' &&
      Array.isArray(school.bbox) && school.bbox.length === 4 && school.bbox.every(Number.isFinite)
    ));
  } catch {
    return [];
  }
}

export function getAllSchools(): CampusDefinition[] {
  return [...CAMPUSES, ...getCustomSchools()];
}

export function saveCustomSchool(school: CampusDefinition): void {
  const schools = getCustomSchools().filter((item) => item.id !== school.id);
  schools.push(school);
  localStorage.setItem(CUSTOM_SCHOOLS_KEY, JSON.stringify(schools));
}

export function deleteCustomSchool(id: string): void {
  localStorage.setItem(CUSTOM_SCHOOLS_KEY, JSON.stringify(getCustomSchools().filter((school) => school.id !== id)));
  clearCampusCache(id);
}

export function createCustomSchool(name: string, lat: number, lon: number, radius: number): CampusDefinition {
  const latitudeRadius = radius / 110540;
  const longitudeRadius = radius / (111320 * Math.max(0.15, Math.cos(lat * Math.PI / 180)));
  const bbox: [number, number, number, number] = [
    lat - latitudeRadius,
    lon - longitudeRadius,
    lat + latitudeRadius,
    lon + longitudeRadius,
  ];
  return {
    id: `custom-${Date.now().toString(36)}`,
    name,
    shortName: name.length > 12 ? `${name.slice(0, 12)}…` : name,
    dataPaths: [],
    bbox,
    custom: true,
  };
}
