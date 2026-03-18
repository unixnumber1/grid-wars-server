// Test income formula: 50 * level^2 per hour
function getMineIncomePerHour(level) {
  return Math.floor(50 * Math.pow(level, 2.0));
}

function getMineCapacity(level) {
  const income = getMineIncomePerHour(level);
  let hours;
  if (level < 50)       hours = 6;
  else if (level < 100) hours = 168;
  else if (level < 110) hours = 240;
  else if (level < 120) hours = 264;
  else if (level < 130) hours = 288;
  else if (level < 140) hours = 312;
  else if (level < 150) hours = 336;
  else if (level < 160) hours = 360;
  else if (level < 170) hours = 384;
  else if (level < 180) hours = 408;
  else if (level < 190) hours = 432;
  else if (level < 200) hours = 456;
  else                  hours = 480;
  return Math.floor(income * hours);
}

console.log('=== INCOME TABLE (50 * level^2) ===');
console.log('Level | Income/ч | Capacity');
console.log('------|----------|--------');

const levels = [1, 5, 10, 20, 30, 50, 70, 100, 120, 150, 170, 200];
for (const lvl of levels) {
  const income = getMineIncomePerHour(lvl);
  const cap = getMineCapacity(lvl);
  console.log(`lv${String(lvl).padStart(3)} | ${income.toLocaleString().padStart(12)}/ч | ${cap.toLocaleString()}`);
}

console.log('\n=== MINE COUNT BOOST ===');
const counts = [1, 10, 50, 100, 500, 1000, 2000];
for (const cnt of counts) {
  const boost = 1 + cnt * 0.001;
  console.log(`${cnt} mines: x${boost.toFixed(1)} (+${(cnt * 0.1).toFixed(1)}%)`);
}

console.log('\n=== COMBINED: lv100 mine + count boost ===');
const lv100income = getMineIncomePerHour(100);
for (const cnt of [100, 500, 1000, 2000]) {
  const boost = 1 + cnt * 0.001;
  console.log(`lv100 + ${cnt} mines: ${Math.floor(lv100income * boost).toLocaleString()}/ч`);
}
