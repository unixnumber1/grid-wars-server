import { haversine } from './haversine.js';

export const CLAN_LEVELS = [
  { level: 1,  radius: 75,  income: 5,  defense: 10, maxMembers: 10,  cost: 0 },
  { level: 2,  radius: 100, income: 8,  defense: 15, maxMembers: 15,  cost: 5000 },
  { level: 3,  radius: 125, income: 11, defense: 20, maxMembers: 20,  cost: 15000 },
  { level: 4,  radius: 150, income: 14, defense: 26, maxMembers: 27,  cost: 40000 },
  { level: 5,  radius: 175, income: 17, defense: 32, maxMembers: 35,  cost: 100000 },
  { level: 6,  radius: 200, income: 20, defense: 38, maxMembers: 45,  cost: 250000 },
  { level: 7,  radius: 225, income: 23, defense: 45, maxMembers: 57,  cost: 600000 },
  { level: 8,  radius: 250, income: 26, defense: 52, maxMembers: 72,  cost: 1500000 },
  { level: 9,  radius: 275, income: 28, defense: 62, maxMembers: 90,  cost: 4000000 },
  { level: 10, radius: 300, income: 30, defense: 75, maxMembers: 120, cost: 10000000 },
];

export const CLAN_HQ_COST = 10000000;
export const CLAN_CREATE_COST = 0;
export const CLAN_LEAVE_COOLDOWN = 72 * 60 * 60 * 1000;
export const LEADER_INACTIVE_DAYS = 7;

export function getClanLevel(level) {
  return CLAN_LEVELS.find(l => l.level === level) || CLAN_LEVELS[0];
}

export function isInClanZone(playerLat, playerLng, hqLat, hqLng, clanLevel) {
  const config = getClanLevel(clanLevel);
  const dist = haversine(playerLat, playerLng, hqLat, hqLng);
  return dist <= config.radius;
}

export const ALLOWED_CLAN_COLORS = [
  '#FF1744', '#FF6D00', '#FFD700', '#00E676',
  '#00B0FF', '#2979FF', '#651FFF', '#D500F9',
  '#FF4081', '#FFFFFF', '#607D8B', '#795548',
];
