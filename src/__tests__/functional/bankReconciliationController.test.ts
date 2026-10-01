import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../config/supabase', () => ({
  getSupabaseUserClient: vi.fn(),
  supabaseAdmin: { from: vi.fn() },
  supabase: {},
}));
vi.mock('../../services/bbExtratoService', () => ({
  bbExtratoService: { fetchExtrato: vi.fn() },
}));

import { getSupabaseUserClient, supabaseAdmin } from '../../config/supabase';
import { bbExtratoService } from '../../services/bbExtratoService';
import { installFakeSupabase } from '../helpers/mockSupabaseConfig';
import { buildTestApp, profileHeader } from '../helpers/testApp';
import { makeBill, makeBankLine } from '../helpers/fixtures';
import billRoutes from '../../routes/billRoutes';
import type { FakeSupabaseDb } from '../helpers/fakeSupabase';

describe('bankReconciliationController', () => {
  let db: FakeSupabaseDb;
  const app = buildTestApp(billRoutes, '/api/bills');

  beforeEach(() => {
    db = installFakeSupabase({ getSupabaseUserClient, supabaseAdmin });
    vi.mocked(bbExtratoService.fetchExtrato).mockReset();
  });

  describe('POST /api/bills/reconcile', () => {
    it('match forte por pix_end_to_end_id ignora tipo/data (só o identificador precisa bater) e marca Recebido', async () => {
      const bill = makeBill({
        type: 'receivable',
        net_value: 999, // igual ao valor do extrato -> sem divergência
        due_date: '2026-01-01', // bem fora da tolerância de data do fallback frouxo
        pix_end_to_end_id: 'E00000000202608201200X1',
      });
      db.seed('bills', [bill]);
      vi.mocked(bbExtratoService.fetchExtrato).mockResolvedValue({
        simulated: false,
        lines: [makeBankLine({ value: 999, unique_transaction_id: 'E00000000202608201200X1' })],
      });

      const res = await request(app)
        .post('/api/bills/reconcile')
        .set('x-test-profile', profileHeader('Administrador'));

      expect(res.status).toBe(200);
      expect(res.body.matched_count).toBe(1);
      expect(res.body.lines[0].matched_bill_id).toBe(bill.id);
      const updated = db.getTable('bills').find((b) => b.id === bill.id)!;
      expect(updated.status).toBe('Recebido');
      expect(updated.net_value).toBe(999);
    });

    it('fallback frouxo casa por tipo+valor+data quando não há identificador forte', async () => {
      const bill = makeBill({ type: 'payable', net_value: 480.5, due_date: '2026-08-18' });
      db.seed('bills', [bill]);
      vi.mocked(bbExtratoService.fetchExtrato).mockResolvedValue({
        simulated: true,
        lines: [makeBankLine({ type: 'payable', dc_indicator: 'D', value: 480.5, bank_date: '2026-08-20' })],
      });

      const res = await request(app)
        .post('/api/bills/reconcile')
        .set('x-test-profile', profileHeader('Administrador'));

      expect(res.body.matched_count).toBe(1);
      expect(res.body.lines[0].matched_bill_id).toBe(bill.id);
    });

    it('marca Divergente (não Recebido) quando o valor do banco diverge do valor cadastrado além da tolerância', async () => {
      const bill = makeBill({ type: 'receivable', net_value: 500, due_date: '2026-08-20', pix_end_to_end_id: 'E1' });
      db.seed('bills', [bill]);
      vi.mocked(bbExtratoService.fetchExtrato).mockResolvedValue({
        simulated: false,
        lines: [makeBankLine({ value: 700, unique_transaction_id: 'E1' })],
      });

      const res = await request(app)
        .post('/api/bills/reconcile')
        .set('x-test-profile', profileHeader('Administrador'));

      const updated = db.getTable('bills').find((b) => b.id === bill.id)!;
      expect(updated.status).toBe('Divergente');
      expect(res.body.lines[0].matched_bill.status).toBe('Divergente');
    });

    it('linha sem candidato correspondente fica unmatched, sem tocar em nenhum bill', async () => {
      db.seed('bills', [makeBill({ type: 'receivable', net_value: 100, due_date: '2026-01-01' })]);
      vi.mocked(bbExtratoService.fetchExtrato).mockResolvedValue({
        simulated: true,
        lines: [makeBankLine({ value: 999999, type: 'payable', dc_indicator: 'D' })],
      });

      const res = await request(app)
        .post('/api/bills/reconcile')
        .set('x-test-profile', profileHeader('Administrador'));

      expect(res.body.matched_count).toBe(0);
      expect(res.body.unmatched_count).toBe(1);
      expect(res.body.lines[0].match_status).toBe('unmatched');
    });

    it('achado documentado: dois bills igualmente elegíveis no fallback frouxo -> casa com o primeiro encontrado, sem sinalizar ambiguidade', async () => {
      // Comportamento atual, não corrigido neste ciclo (ver docs/TESTING_FINDINGS.md).
      const billA = makeBill({ type: 'receivable', net_value: 300, due_date: '2026-08-20' });
      const billB = makeBill({ type: 'receivable', net_value: 300, due_date: '2026-08-21' });
      db.seed('bills', [billA, billB]);
      vi.mocked(bbExtratoService.fetchExtrato).mockResolvedValue({
        simulated: true,
        lines: [makeBankLine({ value: 300, bank_date: '2026-08-20' })],
      });

      const res = await request(app)
        .post('/api/bills/reconcile')
        .set('x-test-profile', profileHeader('Administrador'));

      expect(res.body.matched_count).toBe(1);
      expect(res.body.lines[0].matched_bill_id).toBe(billA.id);
      const untouchedB = db.getTable('bills').find((b) => b.id === billB.id)!;
      expect(untouchedB.status).toBe('Pendente');
    });

    it('match forte por CNPJ da contrapartida casa com o cliente correto mesmo com data fora da tolerância', async () => {
      const { makeClient } = await import('../helpers/fixtures');
      const client = makeClient({ cnpj: '42.293.085/0001-93' });
      const bill = makeBill({
        type: 'receivable',
        client_id: client.id,
        net_value: 7000,
        due_date: '2026-08-01', // 27 dias antes da data do banco
      });
      db.seed('clients', [client]);
      db.seed('bills', [bill]);

      vi.mocked(bbExtratoService.fetchExtrato).mockResolvedValue({
        simulated: false,
        lines: [
          makeBankLine({
            value: 7000,
            bank_date: '2026-08-28',
            counterparty_document: '42293085000193',
            counterparty_name: 'STRUTEX MON',
          }),
        ],
      });

      const res = await request(app)
        .post('/api/bills/reconcile')
        .set('x-test-profile', profileHeader('Administrador'));

      expect(res.body.matched_count).toBe(1);
      expect(res.body.lines[0].matched_bill_id).toBe(bill.id);
      const updated = db.getTable('bills').find((b) => b.id === bill.id)!;
      expect(updated.status).toBe('Recebido');
    });

    it('idempotência bancária: transação já conciliada anteriormente em outro refresh é identificada como matched', async () => {
      const bill = makeBill({
        type: 'receivable',
        net_value: 1250,
        bank_transaction_date: '2026-08-28',
        pix_end_to_end_id: 'BB002202609280080107244972',
        status: 'Recebido',
      });
      db.seed('bills', [bill]);

      vi.mocked(bbExtratoService.fetchExtrato).mockResolvedValue({
        simulated: false,
        lines: [
          makeBankLine({
            value: 1250,
            bank_date: '2026-08-28',
            unique_transaction_id: 'BB002202609280080107244972',
          }),
        ],
      });

      const res = await request(app)
        .post('/api/bills/reconcile?from=2026-08-01&to=2026-08-31')
        .set('x-test-profile', profileHeader('Administrador'));

      expect(res.body.matched_count).toBe(1);
      expect(res.body.lines[0].match_status).toBe('matched');
      expect(res.body.lines[0].matched_bill_id).toBe(bill.id);
    });
  });

  describe('POST /api/bills/:id/link-statement-line', () => {
    it('valida campos obrigatórios da linha', async () => {
      const bill = makeBill();
      db.seed('bills', [bill]);

      const res = await request(app)
        .post(`/api/bills/${bill.id}/link-statement-line`)
        .set('x-test-profile', profileHeader('Administrador'))
        .send({ value: 100 });

      expect(res.status).toBe(400);
    });

    it('vincula manualmente e aplica o valor do extrato ao bill', async () => {
      const bill = makeBill({ net_value: 500 });
      db.seed('bills', [bill]);

      const res = await request(app)
        .post(`/api/bills/${bill.id}/link-statement-line`)
        .set('x-test-profile', profileHeader('Administrador'))
        .send(makeBankLine({ value: 500 }));

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('Recebido');
    });
  });
});
