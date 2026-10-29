import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockHttp, mockGetToken } = vi.hoisted(() => ({
  mockHttp: { get: vi.fn() },
  mockGetToken: vi.fn(),
}));

vi.mock('../../config/bbMtlsAgent', () => ({
  createBbHttpClient: vi.fn(() => mockHttp),
}));
vi.mock('../../services/bbAuthService', () => ({
  getBbAccessToken: mockGetToken,
}));

describe('bbExtratoService', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    mockHttp.get.mockReset();
    mockGetToken.mockReset();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('modo simulado (ENABLE_BB_EXTRATO_FETCH != true): devolve fixture sem chamar o BB', async () => {
    process.env.ENABLE_BB_EXTRATO_FETCH = 'false';
    const { bbExtratoService } = await import('../../services/bbExtratoService');

    const result = await bbExtratoService.fetchExtrato({ from: '2026-08-01', to: '2026-08-20' });

    expect(result.simulated).toBe(true);
    expect(result.lines.length).toBeGreaterThan(0);
    expect(mockHttp.get).not.toHaveBeenCalled();
  });

  it('modo real: pagina até numeroPaginaProximo zerar e filtra linhas informativas (só estágios 1/2/3)', async () => {
    process.env.ENABLE_BB_EXTRATO_FETCH = 'true';
    process.env.BB_APP_KEY = 'app-key';
    process.env.BB_AGENCIA = '551';
    process.env.BB_CONTA = '5087';
    process.env.BB_ENV = 'homologacao';
    mockGetToken.mockResolvedValue('token-123');

    mockHttp.get
      .mockResolvedValueOnce({
        data: {
          numeroPaginaProximo: 2,
          listaLancamento: [
            { indicadorTipoLancamento: '1', dataLancamento: 20082026, valorLancamento: 100, indicadorSinalLancamento: 'C', textoIdentificadorUnicoTransacao: 'E1' },
            { indicadorTipoLancamento: 'SA', dataLancamento: 20082026, valorLancamento: 0, indicadorSinalLancamento: '*' }, // linha de saldo, deve ser descartada
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          numeroPaginaProximo: 0,
          listaLancamento: [
            { indicadorTipoLancamento: '2', dataLancamento: 21082026, valorLancamento: 50, indicadorSinalLancamento: 'D' },
          ],
        },
      });

    const { bbExtratoService } = await import('../../services/bbExtratoService');
    const result = await bbExtratoService.fetchExtrato({ from: '2026-08-01', to: '2026-08-20' });

    expect(result.simulated).toBe(false);
    expect(mockHttp.get).toHaveBeenCalledTimes(2);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toMatchObject({ bank_date: '2026-08-20', value: 100, type: 'receivable', unique_transaction_id: 'E1' });
    expect(result.lines[1]).toMatchObject({ bank_date: '2026-08-21', value: 50, type: 'payable' });
  });

  it('fetchExtratoForSnapshot inclui o lançamento "SA" e extrai periodBalance', async () => {
    process.env.ENABLE_BB_EXTRATO_FETCH = 'true';
    process.env.BB_APP_KEY = 'app-key';
    process.env.BB_AGENCIA = '551';
    process.env.BB_CONTA = '5087';
    process.env.BB_ENV = 'homologacao';
    mockGetToken.mockResolvedValue('token-123');

    mockHttp.get.mockResolvedValueOnce({
      data: {
        numeroPaginaProximo: 0,
        listaLancamento: [
          { indicadorTipoLancamento: 'SA', dataLancamento: 20082026, valorLancamento: 8450.75, indicadorSinalLancamento: 'C', textoDescricaoSubHistorico: 'SALDO ANTERIOR' },
          { indicadorTipoLancamento: '1', dataLancamento: 20082026, valorLancamento: 300, indicadorSinalLancamento: 'C', textoIdentificadorUnicoTransacao: 'E2' },
        ],
      },
    });

    const { bbExtratoService } = await import('../../services/bbExtratoService');
    const result = await bbExtratoService.fetchExtratoForSnapshot({ from: '2026-08-01', to: '2026-08-20' });

    expect(result.simulated).toBe(false);
    expect(result.periodBalance).toBe(8450.75);
    expect(result.saLancamento?.valorLancamento).toBe(8450.75);
    expect(result.lines).toHaveLength(2);
    expect(result.lines.some((l) => (l.raw as any)?.indicadorTipoLancamento === 'SA')).toBe(true);
  });

  it('normaliza erro do BB (shape documentado code/message) em BbApiError', async () => {
    process.env.ENABLE_BB_EXTRATO_FETCH = 'true';
    process.env.BB_APP_KEY = 'app-key';
    process.env.BB_AGENCIA = '551';
    process.env.BB_CONTA = '5087';
    process.env.BB_ENV = 'homologacao';
    mockGetToken.mockResolvedValue('token-123');
    mockHttp.get.mockRejectedValue({
      response: { status: 400, data: { code: 'invalid_request', message: 'período inválido' } },
    });

    const { bbExtratoService, BbApiError } = await import('../../services/bbExtratoService');
    await expect(bbExtratoService.fetchExtrato({ from: '2026-08-01', to: '2026-08-20' })).rejects.toBeInstanceOf(BbApiError);
  });

  it('normaliza erro de gateway (envelope { errors: [...] }, ex: 503) em BbApiError', async () => {
    process.env.ENABLE_BB_EXTRATO_FETCH = 'true';
    process.env.BB_APP_KEY = 'app-key';
    process.env.BB_AGENCIA = '551';
    process.env.BB_CONTA = '5087';
    process.env.BB_ENV = 'homologacao';
    mockGetToken.mockResolvedValue('token-123');
    mockHttp.get.mockRejectedValue({
      response: { status: 503, data: { errors: [{ code: 'gateway_timeout', message: 'Serviço temporariamente indisponível' }] } },
    });

    const { bbExtratoService } = await import('../../services/bbExtratoService');
    await expect(bbExtratoService.fetchExtrato({ from: '2026-08-01', to: '2026-08-20' })).rejects.toThrow(/temporariamente indisponível/);
  });

  it('rejeita agência/conta sem identidade fictícia de homologação configurada', async () => {
    process.env.ENABLE_BB_EXTRATO_FETCH = 'true';
    process.env.BB_APP_KEY = 'app-key';
    process.env.BB_AGENCIA = '999';
    process.env.BB_CONTA = '999';
    process.env.BB_ENV = 'homologacao';
    mockGetToken.mockResolvedValue('token-123');

    const { bbExtratoService } = await import('../../services/bbExtratoService');
    await expect(bbExtratoService.fetchExtrato({ from: '2026-08-01', to: '2026-08-20' })).rejects.toThrow(/identidade fictícia/);
  });
});
