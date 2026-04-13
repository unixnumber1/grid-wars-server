import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getVolcanoPhase, getEruptionHourlyChance } from '../../lib/volcanoPhase.js';

describe('Volcano phases', () => {
  test('dormant phase during first 24h', () => {
    assert.equal(getVolcanoPhase(0).phase, 'dormant');
    assert.equal(getVolcanoPhase(0.5).phase, 'dormant');
    assert.equal(getVolcanoPhase(0.99).phase, 'dormant');
    assert.equal(getVolcanoPhase(0.5).dailyChance, 0);
  });

  test('active phase from day 1 to day 3', () => {
    assert.equal(getVolcanoPhase(1).phase, 'active');
    assert.equal(getVolcanoPhase(2).phase, 'active');
    assert.equal(getVolcanoPhase(2.99).phase, 'active');
    assert.equal(getVolcanoPhase(2).dailyChance, 0.10);
  });

  test('unstable phase from day 3 to day 7', () => {
    assert.equal(getVolcanoPhase(3).phase, 'unstable');
    assert.equal(getVolcanoPhase(5).phase, 'unstable');
    assert.equal(getVolcanoPhase(6.99).phase, 'unstable');
    assert.equal(getVolcanoPhase(5).dailyChance, 0.30);
  });

  test('critical phase from day 7 onwards', () => {
    assert.equal(getVolcanoPhase(7).phase, 'critical');
    assert.equal(getVolcanoPhase(10).phase, 'critical');
    assert.equal(getVolcanoPhase(100).phase, 'critical');
    assert.equal(getVolcanoPhase(10).dailyChance, 0.60);
  });

  test('hourly chance is monotonically non-decreasing across phases', () => {
    const samples = [0.5, 1, 2, 3, 5, 7, 10];
    const chances = samples.map(getEruptionHourlyChance);
    for (let i = 1; i < chances.length; i++) {
      assert.ok(chances[i] >= chances[i - 1], `chance at day ${samples[i]} (${chances[i]}) < at day ${samples[i - 1]} (${chances[i - 1]})`);
    }
  });

  test('hourly chance is 0 during dormant and positive afterwards', () => {
    assert.equal(getEruptionHourlyChance(0.5), 0);
    assert.ok(getEruptionHourlyChance(1) > 0);
    assert.ok(getEruptionHourlyChance(5) > getEruptionHourlyChance(2));
    assert.ok(getEruptionHourlyChance(10) > getEruptionHourlyChance(5));
  });

  test('hourly chance stays below daily chance (probability sanity)', () => {
    assert.ok(getEruptionHourlyChance(10) < 0.60);
    assert.ok(getEruptionHourlyChance(5) < 0.30);
    assert.ok(getEruptionHourlyChance(2) < 0.10);
  });
});
