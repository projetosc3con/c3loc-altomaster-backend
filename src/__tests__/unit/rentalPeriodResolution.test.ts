import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config/supabase', () => ({
  getSupabaseUserClient: vi.fn(),
  supabaseAdmin: { from: vi.fn() },
  supabase: {},
}));

import { resolveLatestMachinesWithSwapStatus } from '../../controllers/rentalController';

describe('resolveLatestMachinesWithSwapStatus', () => {
  it('resolve apenas a máquina ativa atual no caso #247/2026 (PTE0008 substituída por PTE0010 na última renovação)', () => {
    const equipments = [
      {
        id: 'row-1',
        equipment_id: 'eq-pte0008',
        asset_number: 'PTE0008',
        equipment_name: 'PLATAFORMA PANTOGRAFICA (TESOURA)',
        billing_period_start: '2026-08-07',
        billing_period_end: '2026-09-05',
        return_date: null,
      },
      {
        id: 'row-2',
        equipment_id: 'eq-pte0008',
        asset_number: 'PTE0008',
        equipment_name: 'PLATAFORMA PANTOGRAFICA (TESOURA)',
        billing_period_start: '2026-09-06',
        billing_period_end: '2026-10-05',
        return_date: null,
      },
      {
        id: 'row-3',
        equipment_id: 'eq-pte0008',
        asset_number: 'PTE0008',
        equipment_name: 'PLATAFORMA PANTOGRAFICA (TESOURA)',
        billing_period_start: '2026-10-06',
        billing_period_end: '2026-11-04',
        return_date: null,
      },
      {
        id: 'row-4',
        equipment_id: 'eq-pte0010',
        asset_number: 'PTE0010',
        equipment_name: 'PLATAFORMA PANTOGRAFICA (TESOURA)',
        billing_period_start: '2026-11-05',
        billing_period_end: '2026-12-04',
        return_date: null,
      },
    ];

    const res = resolveLatestMachinesWithSwapStatus(equipments);
    expect(res.activeMachines).toHaveLength(1);
    expect(res.activeMachines[0].equipment_id).toBe('eq-pte0010');
    expect(res.activeMachines[0].asset_number).toBe('PTE0010');
    expect(res.supersededMachines).toHaveLength(1);
    expect(res.supersededMachines[0].equipment_id).toBe('eq-pte0008');
  });

  it('resolve apenas a máquina ativa atual no caso #269/2026 (troca de equipment_id na última renovação)', () => {
    const equipments = [
      {
        id: 'row-1',
        equipment_id: 'f0d2cb71-c6d9-4925-bbcd-9e31a0f1b246',
        asset_number: 'PTE0005',
        billing_period_start: '2026-08-26',
        billing_period_end: '2026-09-24',
        return_date: null,
      },
      {
        id: 'row-2',
        equipment_id: 'f0d2cb71-c6d9-4925-bbcd-9e31a0f1b246',
        asset_number: 'PTE0005',
        billing_period_start: '2026-09-25',
        billing_period_end: '2026-10-24',
        return_date: null,
      },
      {
        id: 'row-3',
        equipment_id: 'a9f320ff-a57e-41f1-b5c1-1d02b5e11d99',
        asset_number: 'PTE0005',
        billing_period_start: '2026-10-25',
        billing_period_end: '2026-11-23',
        return_date: null,
      },
    ];

    const res = resolveLatestMachinesWithSwapStatus(equipments);
    expect(res.activeMachines).toHaveLength(1);
    expect(res.activeMachines[0].equipment_id).toBe('a9f320ff-a57e-41f1-b5c1-1d02b5e11d99');
    expect(res.supersededMachines).toHaveLength(1);
    expect(res.supersededMachines[0].equipment_id).toBe('f0d2cb71-c6d9-4925-bbcd-9e31a0f1b246');
  });

  it('mantém duas máquinas ativas simultâneas em locação multimáquina sem troca', () => {
    const equipments = [
      {
        id: 'r1',
        equipment_id: 'eq-a',
        asset_number: 'A',
        billing_period_start: '2026-08-01',
        billing_period_end: '2026-08-30',
        return_date: null,
      },
      {
        id: 'r2',
        equipment_id: 'eq-b',
        asset_number: 'B',
        billing_period_start: '2026-08-01',
        billing_period_end: '2026-08-30',
        return_date: null,
      },
      {
        id: 'r3',
        equipment_id: 'eq-a',
        asset_number: 'A',
        billing_period_start: '2026-08-31',
        billing_period_end: '2026-09-29',
        return_date: null,
      },
      {
        id: 'r4',
        equipment_id: 'eq-b',
        asset_number: 'B',
        billing_period_start: '2026-08-31',
        billing_period_end: '2026-09-29',
        return_date: null,
      },
    ];

    const res = resolveLatestMachinesWithSwapStatus(equipments);
    expect(res.activeMachines.map((m) => m.equipment_id)).toEqual(['eq-a', 'eq-b']);
    expect(res.supersededMachines).toHaveLength(0);
  });

  it('mantém A e C quando B é substituída por C em locação multimáquina', () => {
    const equipments = [
      {
        id: 'r1',
        equipment_id: 'eq-a',
        billing_period_start: '2026-08-01',
        billing_period_end: '2026-08-30',
        return_date: null,
      },
      {
        id: 'r2',
        equipment_id: 'eq-b',
        billing_period_start: '2026-08-01',
        billing_period_end: '2026-08-30',
        return_date: null,
      },
      {
        id: 'r3',
        equipment_id: 'eq-a',
        billing_period_start: '2026-08-31',
        billing_period_end: '2026-09-29',
        return_date: null,
      },
      {
        id: 'r4',
        equipment_id: 'eq-c',
        billing_period_start: '2026-08-31',
        billing_period_end: '2026-09-29',
        return_date: null,
      },
    ];

    const res = resolveLatestMachinesWithSwapStatus(equipments);
    expect(res.activeMachines.map((m) => m.equipment_id)).toEqual(['eq-a', 'eq-c']);
    expect(res.supersededMachines.map((m) => m.equipment_id)).toEqual(['eq-b']);
  });

  it('lida corretamente com retorno para máquina original (A -> B -> A)', () => {
    const equipments = [
      {
        id: 'r1',
        equipment_id: 'eq-a',
        billing_period_start: '2026-08-01',
        billing_period_end: '2026-08-30',
        return_date: null,
      },
      {
        id: 'r2',
        equipment_id: 'eq-b',
        billing_period_start: '2026-08-31',
        billing_period_end: '2026-09-29',
        return_date: null,
      },
      {
        id: 'r3',
        equipment_id: 'eq-a',
        billing_period_start: '2026-09-30',
        billing_period_end: '2026-10-29',
        return_date: null,
      },
    ];

    const res = resolveLatestMachinesWithSwapStatus(equipments);
    expect(res.activeMachines.map((m) => m.equipment_id)).toEqual(['eq-a']);
    expect(res.supersededMachines.map((m) => m.equipment_id)).toEqual(['eq-b']);
  });

  it('mantém máquinas ativas com ciclos sobrepostos e datas diferentes', () => {
    const equipments = [
      {
        id: 'r1',
        equipment_id: 'eq-a',
        billing_period_start: '2026-10-01',
        billing_period_end: '2026-10-30',
        return_date: null,
      },
      {
        id: 'r2',
        equipment_id: 'eq-a',
        billing_period_start: '2026-10-31',
        billing_period_end: '2026-11-29',
        return_date: null,
      },
      {
        id: 'r3',
        equipment_id: 'eq-b',
        billing_period_start: '2026-10-15',
        billing_period_end: '2026-11-13',
        return_date: null,
      },
    ];

    const res = resolveLatestMachinesWithSwapStatus(equipments);
    expect(res.activeMachines.map((m) => m.equipment_id)).toEqual(['eq-a', 'eq-b']);
    expect(res.supersededMachines).toHaveLength(0);
  });

  it('exclui máquinas já devolvidas de activeMachines mas mantém em nonSupersededMachines', () => {
    const equipments = [
      {
        id: 'r1',
        equipment_id: 'eq-old',
        billing_period_start: '2026-08-01',
        billing_period_end: '2026-08-30',
        return_date: null,
      },
      {
        id: 'r2',
        equipment_id: 'eq-new',
        billing_period_start: '2026-08-31',
        billing_period_end: '2026-09-29',
        return_date: '2026-09-29',
      },
    ];

    const res = resolveLatestMachinesWithSwapStatus(equipments);
    expect(res.activeMachines).toHaveLength(0);
    expect(res.supersededMachines.map((m) => m.equipment_id)).toEqual(['eq-old']);
    expect(res.nonSupersededMachines.map((m) => m.equipment_id)).toEqual(['eq-new']);
  });
});

