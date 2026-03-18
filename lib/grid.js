import { latLngToCell, gridDisk, cellToBoundary, cellToLatLng } from 'h3-js';

const H3_RESOLUTION = 10;
const MINE_DISK_K = 12;

export function getCell(lat, lng) {
  return latLngToCell(lat, lng, H3_RESOLUTION);
}

export function getCellId(lat, lng) {
  return getCell(lat, lng);
}

export function getCellsInRange(lat, lng, diskK = MINE_DISK_K) {
  const center = getCell(lat, lng);
  return new Set(gridDisk(center, diskK));
}

export function radiusToDiskK(meters) {
  return Math.ceil(meters / 43);
}

export function getCellBoundary(cellId) {
  return cellToBoundary(cellId);
}

export function getCellCenter(cellId) {
  return cellToLatLng(cellId);
}
