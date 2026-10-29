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

// Para gravação de snapshots de extrato, incluímos também o código 'SA' (Saldo Anterior / Atual)
const SNAPSHOT_STAGE_CODES = new Set(['1', '2', '3', 'SA']);

function dcToType(dc: 'C' | 'D'): BillType {
  return dc === 'C' ? 'receivable' : 'payable';
}

function extractCounterpartyDetails(
  sub?: string,
  comp?: string
): { counterpartyName: string | null; enrichedDescription: string | null } {
  const trimmedComp = (comp || '').trim();
  const trimmedSub = (sub || '').trim();
  let counterpartyName: string | null = null;

  if (trimmedComp) {
    // Formatos do BB em textoInformacaoComplementar:
    // 1) "28/09 11:04 42293085000193 STRUTEX MON"
    // 2) "42293085000193 STRUTEX MON"
    // 3) "STRUTEX MON" ou texto complementar livre ("Dinheiro na Conta")
    const matchWithPrefix = trimmedComp.match(/^(?:\d{2}\/\d{2}(?:\s+\d{2}:\d{2})?\s+)?(?:\d{11,14}\s+)?(.*)$/);
    const candidate = matchWithPrefix && matchWithPrefix[1] ? matchWithPrefix[1].trim() : trimmedComp;
    if (candidate && candidate !== trimmedSub) {
      counterpartyName = candidate;
    }
  }

  let enrichedDescription: string | null = trimmedSub || null;
  if (counterpartyName && counterpartyName !== trimmedSub) {
    enrichedDescription = trimmedSub ? `${trimmedSub} - ${counterpartyName}` : counterpartyName;
  } else if (trimmedComp && trimmedComp !== trimmedSub) {
    enrichedDescription = trimmedSub ? `${trimmedSub} - ${trimmedComp}` : trimmedComp;
  }

  return { counterpartyName, enrichedDescription };
}

function normalizeBbLine(raw: BbExtratoLancamentoRaw): BankStatementLine | null {
  const dc = raw.indicadorSinalLancamento;
  if (dc === '*' && raw.indicadorTipoLancamento !== 'SA') return null; // valor bloqueado, sem D/C definido — não conciliável
  if (raw.valorLancamento === 0 && raw.indicadorTipoLancamento !== 'SA') return null; // saldo anterior ou marcador de saldo do dia com valor 0

  const { counterpartyName, enrichedDescription } = extractCounterpartyDetails(
    raw.textoDescricaoSubHistorico,
    raw.textoInformacaoComplementar
  );

  const cleanDoc = raw.numeroCadastroPessoaFisicaCadastroNacPessoasJuridicasContrapartida
    ? String(raw.numeroCadastroPessoaFisicaCadastroNacPessoasJuridicasContrapartida).replace(/\D/g, '') || null
    : null;

  const effectiveDc: 'C' | 'D' = dc === 'D' ? 'D' : 'C';

  return {
    bank_date: ddmmaaaaToIso(raw.dataLancamento),
    value: Math.abs(raw.valorLancamento),
    dc_indicator: effectiveDc,
    type: dcToType(effectiveDc),
    description: enrichedDescription || (raw.indicadorTipoLancamento === 'SA' ? 'SALDO ANTERIOR' : null),
    counterparty_name: counterpartyName,
    counterparty_document: cleanDoc,
    complementary_info: raw.textoInformacaoComplementar ? String(raw.textoInformacaoComplementar).trim() : null,
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

export interface FetchExtratoResult {
  simulated: boolean;
  lines: BankStatementLine[];
}

export interface FetchExtratoSnapshotResult {
  simulated: boolean;
  lines: BankStatementLine[];
  periodBalance: number;
  saLancamento: BbExtratoLancamentoRaw | null;
}

// Fixture usado enquanto ENABLE_BB_EXTRATO_FETCH não estiver 'true' —
// permite demonstrar o fluxo completo de conciliação e de snapshots com
// saldo do período sem credenciais reais do BB.
function buildSimulatedRawLines(params: ExtratoParams): BbExtratoLancamentoRaw[] {
  const fromNum = parseInt(isoToDdmmaaaa(params.from), 10);
  const from = new Date(params.from);
  const to = new Date(params.to);
  const mid = new Date(from.getTime() + (to.getTime() - from.getTime()) / 2);
  const midNum = parseInt(isoToDdmmaaaa(mid.toISOString().slice(0, 10)), 10);

  return [
    {
      indicadorTipoLancamento: 'SA',
      dataLancamento: fromNum,
      valorLancamento: 15420.5,
      indicadorSinalLancamento: 'C',
      textoDescricaoSubHistorico: 'SALDO ANTERIOR',
      textoInformacaoComplementar: 'Saldo Inicial do Período (simulado)',
    },
    {
      indicadorTipoLancamento: '1',
      dataLancamento: fromNum,
      valorLancamento: 1250.0,
      indicadorSinalLancamento: 'C',
      textoDescricaoSubHistorico: 'PIX RECEBIDO',
      textoInformacaoComplementar: 'PIX RECEBIDO (simulado)',
    },
    {
      indicadorTipoLancamento: '1',
      dataLancamento: midNum,
      valorLancamento: 480.5,
      indicadorSinalLancamento: 'D',
      textoDescricaoSubHistorico: 'PAGAMENTO FORNECEDOR',
      textoInformacaoComplementar: 'PAGAMENTO FORNECEDOR (simulado)',
    },
  ];
}

function buildSimulatedLines(params: ExtratoParams): BankStatementLine[] {
  return buildSimulatedRawLines(params)
    .filter((raw) => TRANSACTION_STAGE_CODES.has(raw.indicadorTipoLancamento))
    .map(normalizeBbLine)
    .filter((line): line is BankStatementLine => line !== null);
}

const MAX_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveRetryDelay(): number {
  return process.env.NODE_ENV === 'test' ? 10 : 1500;
}

function resolvePacingDelay(): number {
  return process.env.NODE_ENV === 'test' ? 0 : 600;
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
    const retryDelay = resolveRetryDelay();
    let attempt = 0;

    while (true) {
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
        if ((status === 503 || status === 429) && attempt < MAX_RETRIES) {
          attempt++;
          console.warn(
            `[bbExtratoService] BB retornou HTTP ${status} na página ${pageNumber}. Tentativa ${attempt} de ${MAX_RETRIES} após ${retryDelay}ms...`
          );
          await sleep(retryDelay);
          continue;
        }

        if (status && err.response?.data) {
          throw new BbApiError(status, err.response.data as BbApiErrorResponse);
        }
        throw err;
      }
    }
  }

  // Busca todas as páginas brutas de extrato no BB (ou gera fixture simulado)
  private async fetchRawLines(params: ExtratoParams): Promise<{ simulated: boolean; rawLines: BbExtratoLancamentoRaw[] }> {
    if (process.env.ENABLE_BB_EXTRATO_FETCH !== 'true') {
      console.log('[bbExtratoService.fetchRawLines] SIMULADO (ENABLE_BB_EXTRATO_FETCH=false) - período:', params);
      return { simulated: true, rawLines: buildSimulatedRawLines(params) };
    }

    assertPeriodWithinLimit(params.from, params.to);

    const appKey = process.env.BB_APP_KEY;
    const agencia = process.env.BB_AGENCIA;
    const conta = process.env.BB_CONTA;
    if (!appKey || !agencia || !conta) {
      throw new Error('BB_APP_KEY/BB_AGENCIA/BB_CONTA não configurados');
    }

    const token = await getBbAccessToken(BB_EXTRATO_SCOPE);
    const pacingDelay = resolvePacingDelay();

    const rawLines: BbExtratoLancamentoRaw[] = [];
    let pageNumber = 1;
    for (let i = 0; i < MAX_PAGES_SAFETY; i++) {
      const page = await this.fetchPage(agencia, conta, appKey, token, params, pageNumber);
      rawLines.push(...(page.listaLancamento ?? []));
      if (!page.numeroPaginaProximo) break;

      // Pacing preventivo: evita requisições em rajada que disparam bloqueio/rate-limit no gateway do BB
      if (pacingDelay > 0) {
        await sleep(pacingDelay);
      }
      pageNumber = page.numeroPaginaProximo;
    }

    return { simulated: false, rawLines };
  }

  // Busca o extrato de conta corrente no período informado para CONCILIAÇÃO.
  // Suprime códigos informativos como 'SA', trazendo apenas transações reais ('1','2','3').
  async fetchExtrato(params: ExtratoParams): Promise<FetchExtratoResult> {
    const { simulated, rawLines } = await this.fetchRawLines(params);
    const lines = rawLines
      .filter((raw) => TRANSACTION_STAGE_CODES.has(raw.indicadorTipoLancamento))
      .map(normalizeBbLine)
      .filter((line): line is BankStatementLine => line !== null);

    return { simulated, lines };
  }

  // Busca o extrato de conta corrente no período informado para ARMAZENAMENTO DE SNAPSHOT.
  // Inclui o código 'SA' (Saldo Anterior / Saldo Atual) e extrai o saldo do período.
  async fetchExtratoForSnapshot(params: ExtratoParams): Promise<FetchExtratoSnapshotResult> {
    const { simulated, rawLines } = await this.fetchRawLines(params);

    // Encontra o lançamento do tipo 'SA' para computar o saldo do período
    const saRaw = rawLines.find((raw) => raw.indicadorTipoLancamento === 'SA') || null;
    let periodBalance = 0;
    if (saRaw) {
      const rawVal = Number(saRaw.valorLancamento) || 0;
      periodBalance = saRaw.indicadorSinalLancamento === 'D' ? -Math.abs(rawVal) : Math.abs(rawVal);
    }

    const lines = rawLines
      .filter((raw) => SNAPSHOT_STAGE_CODES.has(raw.indicadorTipoLancamento))
      .map(normalizeBbLine)
      .filter((line): line is BankStatementLine => line !== null);

    return {
      simulated,
      lines,
      periodBalance,
      saLancamento: saRaw,
    };
  }
}

export const bbExtratoService = new BbExtratoService();
