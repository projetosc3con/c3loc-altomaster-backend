// Tipos para as APIs do Banco do Brasil (Developers BB). Os shapes de Pix
// abaixo ainda são best-effort — nenhum validado contra a doc oficial,
// confirmar campo a campo antes de setar ENABLE_BB_PIX_TRANSFER=true (mesma
// ressalva usada em src/types/asaas.ts). Os shapes de Extrato mais abaixo já
// refletem a especificação OpenAPI oficial da API de Extratos v2.

// --- OAuth2 (client_credentials) ---
export interface BbOAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // segundos
  scope: string;
}

// --- Dados bancários de destino (origem: erp_company_settings) ---
export interface BbPixDestination {
  bankCode: string | null;
  agency: string | null;
  account: string | null;
  pixKey: string | null;
}

// --- Transferência PIX — payload de saída (best-effort) ---
export interface BbPixTransferRequest {
  valor: number;
  chave?: string; // chave PIX do favorecido, quando disponível
  descricao?: string;
  identificadorExterno?: string; // sugestão: payments.id, pra rastrear/idempotência do lado do BB
}

// --- Transferência PIX — resposta (best-effort) ---
export interface BbPixTransferResponse {
  endToEndId: string; // identificador único do PIX — chave de conciliação com o extrato
  dataTransferencia: string; // YYYY-MM-DD
  status: string;
}

// Resultado normalizado devolvido por bbPixService.transferNetValueToBB,
// unificando o caminho real e o caminho simulado (ENABLE_BB_PIX_TRANSFER=false).
export interface BbPixTransferResult {
  simulated: boolean;
  endToEndId: string | null;
  transferDate: string | null;
  raw: Record<string, unknown> | null;
}

// --- Extrato de Conta Corrente v2 — baseado na especificação OpenAPI oficial
// (Developers BB, "Extratos" v2.0.1, servers extratos.mtls.api.{hm.}bb.com.br/v2).
// Diferente do Pix acima, este shape reflete a doc real, não é mais chute.
//
// `indicadorTipoLancamento` é o ESTÁGIO do lançamento, não débito/crédito:
// '1' contabilizado, '2' futuro, '3' em processamento; além de códigos de
// saldo/limite que vêm misturados na mesma lista e devem ser descartados
// antes de conciliar: 'SA' saldo atual, 'RA' saldo invest. resgate automático,
// 'LE' lim. extra cartão utilizado, 'SD' saldo disponível, 'LD' limite
// disponível, 'LC' limite contratado, 'LU' limite utilizado.
// O campo de Débito/Crédito de fato é `indicadorSinalLancamento`.
export interface BbExtratoLancamentoRaw {
  indicadorTipoLancamento: string;
  dataLancamento: number; // DDMMAAAA
  dataMovimento?: number; // DDMMAAAA, só em lançamentos retroativos
  codigoAgenciaOrigem?: number;
  numeroLote?: number;
  numeroDocumento?: number; // int64
  codigoHistorico?: number;
  textoDescricaoSubHistorico?: string; // descrição textual do lançamento (max 25)
  codigoSubHistorico?: number;
  valorLancamento: number; // sempre magnitude positiva
  indicadorSinalLancamento: 'C' | 'D' | '*'; // crédito / débito / valor bloqueado
  textoInformacaoComplementar?: string; // max 38
  numeroCadastroPessoaFisicaCadastroNacPessoasJuridicasContrapartida?: string; // CPF/CNPJ contraparte
  indicadorTipoPessoaContrapartida?: 'F' | 'J';
  codigoBancoContrapartida?: number;
  codigoAgenciaContrapartida?: number;
  numeroContaContrapartida?: string;
  textoDigitoVerificadorContaContrapartida?: string;
  numeroISPB?: number;
  textoIdentificadorUnicoTransacao?: string; // max 64 — útil pra cruzar com pix_end_to_end_id
  codigoConfederacaoNacionalBancos?: number;
  textoCampoIndeterminado?: string;
  [key: string]: unknown;
}

export interface BbExtratoResponseRaw {
  numeroPaginaAtual: number;
  quantidadeRegistroPaginaAtual: number;
  numeroPaginaAnterior: number;
  numeroPaginaProximo: number; // 0 = última página
  quantidadeTotalPagina: number;
  quantidadeTotalRegistro: number;
  listaLancamento: BbExtratoLancamentoRaw[];
}

// Corpo de erro 422 ("Erro Negocial") / 500 ("Erro Sistema") da API de Extratos,
// conforme a doc oficial (shape plano).
export interface BbApiErrorResponseFlat {
  code: string;
  message: string;
  variaveisMonitoradas?: Record<string, unknown>[];
}

// Envelope de erro do gateway (observado empiricamente em 503 "Serviço
// temporariamente indisponível", fora da doc de Extratos — provavelmente
// comum a outras falhas de infraestrutura do gateway BB, não específico
// desta API).
export interface BbApiErrorResponseGateway {
  errors: Array<{ code: string; title?: string; message?: string; detail?: string }>;
}

export type BbApiErrorResponse = BbApiErrorResponseFlat | BbApiErrorResponseGateway;
