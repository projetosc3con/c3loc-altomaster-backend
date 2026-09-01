import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../config/supabase', () => ({
  getSupabaseUserClient: vi.fn(),
  supabaseAdmin: { from: vi.fn() },
  supabase: {},
}));

import { getSupabaseUserClient, supabaseAdmin } from '../../config/supabase';
import { installFakeSupabase } from '../helpers/mockSupabaseConfig';
import { makeBill, makeInvoice, makeClient } from '../helpers/fixtures';
import powerBiRoutes from '../../routes/powerBiRoutes';
import type { FakeSupabaseDb } from '../helpers/fakeSupabase';

const VALID_API_KEY = 'pbi_sec_altomaster_2026_c3loc_key';

describe('powerBiRoutes', () => {
  let db: FakeSupabaseDb;
  const app = express();
  app.use(express.json());
  app.use('/api/powerbi', powerBiRoutes);

  beforeEach(() => {
    db = installFakeSupabase({ getSupabaseUserClient, supabaseAdmin });
  });

  describe('Autenticação via API Key estática', () => {
    it('deve retornar 401 caso nenhuma API key seja informada', async () => {
      const res = await request(app).get('/api/powerbi/rental_invoices');
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });

    it('deve retornar 401 com chave inválida', async () => {
      const res = await request(app)
        .get('/api/powerbi/rental_invoices')
        .set('x-api-key', 'chave_errada');
      expect(res.status).toBe(401);
    });

    it('deve permitir acesso com header x-api-key válido', async () => {
      const invoice = makeInvoice();
      db.seed('rental_invoices', [invoice]);

      const res = await request(app)
        .get('/api/powerbi/rental_invoices')
        .set('x-api-key', VALID_API_KEY);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0].id).toBe(invoice.id);
    });

    it('deve permitir acesso com header Authorization: Bearer <key>', async () => {
      const res = await request(app)
        .get('/api/powerbi')
        .set('Authorization', `Bearer ${VALID_API_KEY}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.endpoints).toBeDefined();
    });
  });

  describe('Endpoints das Tabelas', () => {
    it('GET /api/powerbi/bills deve listar todos os bills', async () => {
      const bill = makeBill({ gross_value: 5000 });
      db.seed('bills', [bill]);

      const res = await request(app)
        .get('/api/powerbi/bills')
        .set('x-api-key', VALID_API_KEY);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0].id).toBe(bill.id);
    });

    it('GET /api/powerbi/clients deve listar clientes', async () => {
      const client = makeClient({ company_name: 'Empresa Teste Power BI' });
      db.seed('clients', [client]);

      const res = await request(app)
        .get('/api/powerbi/clients')
        .set('x-api-key', VALID_API_KEY);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0].company_name).toBe('Empresa Teste Power BI');
    });

    it('GET /api/powerbi/equipments deve listar equipamentos', async () => {
      const eq = { id: 'eq-1', name: 'Guindaste 100T', asset_number: 'EQ-001', status: 'Disponível' };
      db.seed('equipments', [eq]);

      const res = await request(app)
        .get('/api/powerbi/equipments')
        .set('x-api-key', VALID_API_KEY);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0].id).toBe('eq-1');
    });

    it('GET /api/powerbi/users_profiles deve listar usuários', async () => {
      const user = { id: 'u-1', full_name: 'Diretor Geral', email: 'diretor@altomaster.com.br', access_level: 'Diretoria' };
      db.seed('users_profiles', [user]);

      const res = await request(app)
        .get('/api/powerbi/users_profiles')
        .set('x-api-key', VALID_API_KEY);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0].full_name).toBe('Diretor Geral');
    });
  });
});
