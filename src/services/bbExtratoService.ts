import { AxiosInstance } from 'axios';
import { BbApiErrorResponse, BbExtratoLancamentoRaw, BbExtratoResponseRaw } from '../types/bb';
import { BankStatementLine, BillType } from '../types/bill';
import { getBbAccessToken } from './bbAuthService';
import { createBbHttpClient } from '../config/bbMtlsAgent';

const BB_EXTRATO_SCOPE = 'extrato-info';
const MAX_PERIOD_DAYS = 31; // limite documentado pela API entre dataInicioSolicitacao/dataFimSolicitacao
const PAGE_SIZE = 120; // máximo permitido pela API
const MAX_PAGES_SAFETY = 200; // guard contra loop infinito se numeroPaginaProximo nunca zerar

type BbEnv = 'homologacao' | 'producao';

function resolveBbEnv(): BbEnv {
  return process.env.BB_ENV === 'producao' ? 'producao' : 'homologacao';
}

function resolveExtratoBaseUrl(): string {
  if (process.env.BB_EXTRATO_BASE_URL) return process.env.BB_EXTRATO_BASE_URL;
  return resolveBbEnv() === 'producao'
    ? 'https://extratos.mtls.api.bb.com.br/v2'
    : 'https://extratos.mtls.api.hm.bb.com.br/v2';
}

// Identidades fictícias de homologação (doc oficial da API de Extratos) —
// cada uma vinculada a um par agência/conta específico. O header
// x-br-com-bb-ipa-mciteste é obrigatório em homologação (proibido em
// produção) e precisa levar exatamente o valor correspondente ao par usado.
const MCITESTE_IDENTITIES: Record<string, string> = {
  '551:5087': '26968930',
  '1505:1348': '178961031',
  '452:123873': '704950857',
};

function resolveMciTesteHeader(agencia: string, conta: string): string | undefined {
  if (resolveBbEnv() !== 'homologacao') return undefined;
  const identity = MCITESTE_IDENTITIES[`${agencia}:${conta}`];
  if (!identity) {
    throw new Error(
      `BB_AGENCIA/BB_CONTA (${agencia}/${conta}) não corresponde a nenhuma identidade fictícia de homologação da ` +
      'API de Extratos (551/5087, 1505/1348, 452/123873).'
    );
  }
  return identity;
}

function isoToDdmmaaaa(iso: string): string {
  const [y, m, d] = (iso || '').split('-');
  const day = (d || '').padStart(2, '0');
  const month = (m || '').padStart(2, '0');
  const year = (y || '').padStart(4, '0');
  return `${day}${month}${year}`;
}

function ddmmaaaaToIso(value: number): string {
  const s = String(value).padStart(8, '0');
  return `${s.slice(4, 8)}-${s.slice(2, 4)}-${s.slice(0, 2)}`;
}

function assertPeriodWithinLimit(from: string, to: string) {
  const days = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000);
  if (days > MAX_PERIOD_DAYS) {
    throw new Error(`Período de ${days} dias excede o limite de ${MAX_PERIOD_DAYS} dias da API de Extratos do BB.`);
  }
}

// Estágios de lançamento que representam movimentos reais — os demais
// códigos ('SA','RA','LE','SD','LD','LC','LU') são linhas informativas de
// saldo/limite misturadas na mesma lista pela API, não transações, e devem
// ser descartadas antes de conciliar.
const TRANSACTION_STAGE_CODES = new Set(['1', '2', '3']);

function dcToType(dc: 'C' | 'D'): BillType {
  return dc === 'C' ? 'receivable' : 'payable';
}

function normalizeBbLine(raw: BbExtratoLancamentoRaw): BankStatementLine | null {
  const dc = raw.indicadorSinalLancamento;
  if (dc === '*') return null; // valor bloqueado, sem D/C definido — não conciliável

  return {
    bank_date: ddmmaaaaToIso(raw.dataLancamento),
    value: Math.abs(raw.valorLancamento),
    dc_indicator: dc,
    type: dcToType(dc),
    description: raw.textoDescricaoSubHistorico ?? raw.textoInformacaoComplementar ?? null,
    document_number: raw.numeroDocumento != null ? String(raw.numeroDocumento) : null,
    unique_transaction_id: raw.textoIdentificadorUnicoTransacao || null,
    raw: raw as unknown as Record<string, unknown>,
  };
}

export class BbApiError extends Error {
  status: number;
  code: string | null;
  details?: Record<string, unknown>[];

  constructor(status: number, body: BbApiErrorResponse) {
    // Duas formas de erro já observadas na prática: o shape documentado da
    // API de Extratos (plano, `code`/`message`) e um envelope de gateway
    // (`{ errors: [...] }`, visto em 503 "Serviço temporariamente
    // indisponível") — normaliza os dois pra sempre extrair uma mensagem
    // legível em vez de deixar o axios usar o genérico "Request failed with
    // status code X".
    const gatewayError = 'errors' in body ? body.errors[0] : null;
    const code = gatewayError?.code ?? ('code' in body ? body.code : null) ?? null;
    const message =
      gatewayError?.detail ??
      gatewayError?.message ??
      gatewayError?.title ??
      ('message' in body ? body.message : null) ??
      JSON.stringify(body);

    super(`BB API error${code ? ` ${code}` : ''} (HTTP ${status}): ${message}`);
    this.status = status;
    this.code = code;
    this.details = 'variaveisMonitoradas' in body ? body.variaveisMonitoradas : undefined;
  }
}

interface ExtratoParams {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

interface FetchExtratoResult {
  simulated: boolean;
  lines: BankStatementLine[];
}

// Fixture pequeno e claramente fake, usado enquanto ENABLE_BB_EXTRATO_FETCH
// não estiver 'true' — permite demonstrar o fluxo completo de conciliação
// (match/vincular/cadastrar) sem credenciais reais do BB. Os valores/datas
// não têm relação com dados reais; ajuste-os se quiser forçar um match
// contra bills de teste específicos.
function buildSimulatedLines(params: ExtratoParams): BankStatementLine[] {
  const from = new Date(params.from);
  const to = new Date(params.to);
  const mid = new Date(from.getTime() + (to.getTime() - from.getTime()) / 2);
  const midIso = mid.toISOString().slice(0, 10);

  return [
    {
      bank_date: params.from,
      value: 1250.0,
      dc_indicator: 'C',
      type: 'receivable',
      description: 'PIX RECEBIDO (simulado)',
      document_number: null,
      unique_transaction_id: null,
      raw: { simulated: true, data: params.from, valorLancamento: 1250.0, indicadorSinalLancamento: 'C' },
    },
    {
      bank_date: midIso,
      value: 480.5,
      dc_indicator: 'D',
      type: 'payable',
      description: 'PAGAMENTO FORNECEDOR (simulado)',
      document_number: null,
      unique_transaction_id: null,
      raw: { simulated: true, data: midIso, valorLancamento: 480.5, indicadorSinalLancamento: 'D' },
    },
  ];
}

class BbExtratoService {
  private httpCache: AxiosInstance | null = null;

  // Carregamento lazy — só monta o client (e só então exige o certificado
  // mTLS configurado) quando a integração real é de fato usada; nunca no
  // momento em que a classe é instanciada (import time), pra não quebrar o
  // boot da aplicação em ambientes onde ENABLE_BB_EXTRATO_FETCH=false.
  private getHttp(): AxiosInstance {
    if (!this.httpCache) this.httpCache = createBbHttpClient(resolveExtratoBaseUrl());
    return this.httpCache;
  }

  private async fetchPage(
    agencia: string,
    conta: string,
    appKey: string,
    token: string,
    params: ExtratoParams,
    pageNumber: number
  ): Promise<BbExtratoResponseRaw> {
    const mciTeste = resolveMciTesteHeader(agencia, conta);
    try {
      const { data } = await this.getHttp().get<BbExtratoResponseRaw>(
        `/conta-corrente/agencia/${agencia}/conta/${conta}`,
        {
          params: {
            'gw-dev-app-key': appKey,
            dataInicioSolicitacao: isoToDdmmaaaa(params.from),
            dataFimSolicitacao: isoToDdmmaaaa(params.to),
            numeroPaginaSolicitacao: pageNumber,
            quantidadeRegistroPaginaSolicitacao: PAGE_SIZE,
          },
          headers: {
            Authorization: `Bearer ${token}`,
            ...(mciTeste ? { 'x-br-com-bb-ipa-mciteste': mciTeste } : {}),
          },
        }
      );
      return data;
    } catch (err: any) {
      const status = err.response?.status;
      if (status && err.response?.data) {
        throw new BbApiError(status, err.response.data as BbApiErrorResponse);
      }
      throw err;
    }
  }

  // Busca o extrato de conta corrente no período informado, paginando até
  // esgotar (numeroPaginaProximo === 0). Enquanto ENABLE_BB_EXTRATO_FETCH
  // !== 'true', não chama o BB — devolve um fixture simulado (ver
  // buildSimulatedLines), pra permitir testar o fluxo completo de
  // conciliação sem depender de certificado/credenciais reais do BB.
  async fetchExtrato(params: ExtratoParams): Promise<FetchExtratoResult> {
    if (process.env.ENABLE_BB_EXTRATO_FETCH !== 'true') {
      console.log('[bbExtratoService.fetchExtrato] SIMULADO (ENABLE_BB_EXTRATO_FETCH=false) - período:', params);
      return { simulated: true, lines: buildSimulatedLines(params) };
    }

    assertPeriodWithinLimit(params.from, params.to);

    const appKey = process.env.BB_APP_KEY;
    const agencia = process.env.BB_AGENCIA;
    const conta = process.env.BB_CONTA;
    if (!appKey || !agencia || !conta) {
      throw new Error('BB_APP_KEY/BB_AGENCIA/BB_CONTA não configurados');
    }

    const token = await getBbAccessToken(BB_EXTRATO_SCOPE);

    const rawLines: BbExtratoLancamentoRaw[] = [];
    let pageNumber = 1;
    for (let i = 0; i < MAX_PAGES_SAFETY; i++) {
      const page = await this.fetchPage(agencia, conta, appKey, token, params, pageNumber);
      rawLines.push(...(page.listaLancamento ?? []));
      if (!page.numeroPaginaProximo) break;
      pageNumber = page.numeroPaginaProximo;
    }

    const lines = rawLines
      .filter((raw) => TRANSACTION_STAGE_CODES.has(raw.indicadorTipoLancamento))
      .map(normalizeBbLine)
      .filter((line): line is BankStatementLine => line !== null);

    return { simulated: false, lines };
  }
}

export const bbExtratoService = new BbExtratoService();
