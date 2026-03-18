// Test core multipliers and costs
function getCoreMultiplier(level) {
  if (level <= 0) return 1.5;
  return Math.round((1.5 + Math.pow(level / 100, 0.7) * 98.5) * 10) / 10;
}

function getCoreUpgradeCost(level) {
  if (level < 10)  return 100;
  if (level < 25)  return 400;
  if (level < 50)  return 1500;
  if (level < 75)  return 5000;
  if (level < 90)  return 20000;
  return 53000;
}

console.log('=== CORE MULTIPLIERS ===');
console.log('Level | Multiplier | Upgrade Cost');
console.log('------|-----------|-------------');
const levels = [0, 1, 5, 10, 15, 25, 50, 75, 90, 100];
for (const lvl of levels) {
  console.log(`lv${String(lvl).padStart(3)} | x${String(getCoreMultiplier(lvl)).padStart(6)} | ${getCoreUpgradeCost(lvl).toLocaleString()} ether`);
}

console.log('\n=== 10 CORES OF SAME LEVEL ===');
for (const lvl of [0, 10, 50, 100]) {
  const totalBoost = 10 * getCoreMultiplier(lvl);
  console.log(`10x lv${lvl}: x${totalBoost.toFixed(1)}`);
}

console.log('\n=== MINE lv200 WITH 10 CORES lv100 ===');
const incPerHour = Math.floor(50 * Math.pow(200, 2.0));
const coreBoost = 10 * getCoreMultiplier(100);
console.log(`lv200 base income: ${incPerHour.toLocaleString()}/ч`);
console.log(`10x lv100 cores: x${coreBoost}`);
console.log(`lv200 + cores: ${Math.floor(incPerHour * coreBoost).toLocaleString()}/ч`);

console.log('\n=== TOTAL UPGRADE COST to lv100 ===');
let totalCost = 0;
for (let l = 0; l < 100; l++) {
  totalCost += getCoreUpgradeCost(l);
}
console.log(`Total ether for lv0→lv100: ${totalCost.toLocaleString()}`);

console.log('\n=== DROP CHANCES ===');
const chances = { 1:0.02, 2:0.03, 3:0.05, 4:0.10, 5:0.12, 6:0.15, 7:0.20, 8:0.25, 9:0.30, 10:0.40 };
for (const [lvl, ch] of Object.entries(chances)) {
  console.log(`Monument lv${lvl}: ${(ch*100).toFixed(0)}%`);
}
