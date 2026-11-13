import axios from 'axios';
import { supabaseAdmin } from '../config/supabase';
import { generateClassicDanfePdfBuffer } from './danfeGeneratorService';

const getNotaasBaseUrl = (): string => {
  const envUrl = process.env.NOTAAS_BASE_URL || 'https://platform.notaas.com.br';
  if (envUrl.includes('api.notaas.com.br')) {
    return 'https://platform.notaas.com.br';
  }
  return envUrl;
};

const NOTAAS_BASE_URL = getNotaasBaseUrl();
const NOTAAS_API_KEY = process.env.NOTAAS_API_KEY || 'ntaas_xXtwWi7iMczesjz700x5GY3WBxLs9x89';

const notaasClient = axios.create({
  baseURL: NOTAAS_BASE_URL,
  headers: {
    'x-api-key': NOTAAS_API_KEY,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

// Interceptor para garantir que a chave de produção injetada no ambiente (ex: Vercel) seja lida dinamicamente
notaasClient.interceptors.request.use((config) => {
  const currentKey = process.env.NOTAAS_API_KEY || NOTAAS_API_KEY;
  if (currentKey) {
    config.headers['x-api-key'] = currentKey;
  }
  config.baseURL = getNotaasBaseUrl();
  return config;
});

const ibgeCache = new Map<string, Array<{ id: number; nome: string }>>();

const normalizeCityText = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

export const resolveIbgeCityCode = async (cityName?: string, uf?: string): Promise<string> => {
  const cleanUf = (uf || 'MT').toUpperCase().trim();
  const cleanCity = cityName ? normalizeCityText(cityName) : '';

  const capitalFallbacks: Record<string, string> = {
    MT: '5103403', // Cuiabá
    MS: '5002704', // Campo Grande
    SP: '3550308', // São Paulo
    PR: '4106902', // Curitiba
    SC: '4205407', // Florianópolis
    RS: '4314902', // Porto Alegre
    RJ: '3304557', // Rio de Janeiro
    MG: '3106200', // Belo Horizonte
    GO: '5208707', // Goiânia
    DF: '5300108', // Brasília
    RO: '1100205', // Porto Velho
    PA: '1501402', // Belém
    AM: '1302603', // Manaus
  };

  if (!cleanCity) return capitalFallbacks[cleanUf] || '5103403';

  try {
    let cities = ibgeCache.get(cleanUf);
    if (!cities) {
      const res = await axios.get(
        `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${cleanUf}/municipios`,
        { timeout: 5000 }
      );
      cities = res.data;
      if (cities && Array.isArray(cities)) {
        ibgeCache.set(cleanUf, cities);
      }
    }

    if (cities && Array.isArray(cities)) {
      const match = cities.find((c: any) => normalizeCityText(c.nome) === cleanCity);
      if (match) return String(match.id);
    }
  } catch (err) {
    console.warn(`[resolveIbgeCityCode] Consulta IBGE para ${cityName}/${cleanUf} falhou, usando fallback:`, err);
  }

  return capitalFallbacks[cleanUf] || '5103403';
};

export interface NfeEquipmentItem {
  equipment_id?: string;
  asset_number?: string;
  equipment_name?: string;
  model?: string;
  serial_number?: string;
  ncm?: string;
  value?: number;
}

export interface NfeRecipientData {
  company_name: string;
  cnpj: string;
  state_subscription?: string | null;
  address_street?: string;
  address_number?: string;
  address_neighborhood?: string;
  address_city?: string;
  address_state?: string;
  address_zip?: string;
  ibge_code?: string;
}

export interface EmitRemessaParams {
  direction: 'SAIDA' | 'RETORNO';
  dealContractId?: string;
  rentalInvoiceId?: string;
  contractNumber?: string;
  workSite?: string;
  recipient: NfeRecipientData;
  equipments: NfeEquipmentItem[];
  userId?: string;
}

/**
 * Sanitiza dígitos de CPF/CNPJ/CEP
 */
function cleanDigits(val?: string | null): string {
  if (!val) return '';
  return val.replace(/\D/g, '');
}

/**
 * Verifica se a Inscrição Estadual indica cliente isento ou não-contribuinte
 */
export function isClientIsento(ie?: string | null): boolean {
  if (!ie) return true;
  const clean = ie.trim().toUpperCase();
  return clean === '' || clean === 'ISENTO' || clean === 'ISENTA' || clean === 'NAO' || clean === 'NÃO';
}

export class NotaasService {
  /**
   * Enfileira a emissão da NF-e no Notaas
   */
  async enqueueNfe(payload: any): Promise<{ invoiceId: string; status: string; pollUrl: string }> {
    try {
      const response = await notaasClient.post('/api/v1/nfe/emitir', payload);
      return response.data;
    } catch (err: any) {
      if (err.response?.data) {
        const errorDetail =
          err.response.data.error ||
          err.response.data.message ||
          (err.response.data.campos ? JSON.stringify(err.response.data.campos) : JSON.stringify(err.response.data));
        console.error('[NotaasService] Erro retornado pela API Notaas:', errorDetail);
        throw new Error(`Erro na validação da API Notaas: ${errorDetail}`);
      }
      throw err;
    }
  }

  /**
   * Consulta o status atual da NF-e na SEFAZ via Notaas
   */
  async getNfeStatus(invoiceId: string): Promise<any> {
    const response = await notaasClient.get(`/api/v1/nfe/invoices/${invoiceId}/status`);
    return response.data;
  }

  /**
   * Baixa a string XML oficial (nfeProc) autorizada
   */
  async getNfeXml(invoiceId: string): Promise<string> {
    const response = await notaasClient.get(`/api/v1/nfe/invoices/${invoiceId}/xml`, {
      responseType: 'text',
    });
    return response.data;
  }

  /**
   * Faz polling até a nota atingir status terminal ('issued' ou 'error' / 'cancelled')
   */
  async pollUntilTerminal(invoiceId: string, maxAttempts = 40, delayMs = 2500): Promise<any> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const statusData = await this.getNfeStatus(invoiceId);
      const st = statusData.status;

      if (st === 'issued' || st === 'error' || st === 'cancelled') {
        return statusData;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const finalCheck = await this.getNfeStatus(invoiceId);
    if (finalCheck?.status === 'issued' || finalCheck?.status === 'error' || finalCheck?.status === 'cancelled') {
      return finalCheck;
    }

    throw new Error('Tempo limite excedido aguardando autorização da NF-e pela SEFAZ. Consulte o status da nota no painel do Notaas.');
  }

  /**
   * Cancela uma NF-e autorizada junto à SEFAZ via Notaas (`POST /api/v1/nfe/cancelar`)
   */
  async cancelNfe(invoiceId: string, motivo: string): Promise<any> {
    const cleanMotivo = (motivo || '').trim() || 'Cancelamento da locacao antes da saida fisica do equipamento';
    const finalMotivo =
      cleanMotivo.length < 15
        ? `${cleanMotivo} - Cancelamento de operacao de remessa`.slice(0, 255)
        : cleanMotivo.slice(0, 255);

    let cancelResponseData: any;
    try {
      const response = await notaasClient.post('/api/v1/nfe/cancelar', {
        invoiceId,
        motivo: finalMotivo,
      });
      cancelResponseData = response.data;
    } catch (err: any) {
      if (err.response?.data) {
        const errorDetail =
          err.response.data.error ||
          err.response.data.message ||
          err.response.data.motivo ||
          (err.response.data.campos ? JSON.stringify(err.response.data.campos) : JSON.stringify(err.response.data));
        console.error('[NotaasService] Erro ao solicitar cancelamento na API Notaas:', errorDetail);
        throw new Error(`Falha ao cancelar NF-e na SEFAZ: ${errorDetail}`);
      }
      throw err;
    }

    if (cancelResponseData?.status === 'cancelled') {
      return cancelResponseData;
    }

    const maxAttempts = 20;
    const delayMs = 2000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const statusData = await this.getNfeStatus(invoiceId);
      const st = statusData?.status;

      if (st === 'cancelled') {
        return statusData;
      }

      if (st === 'error') {
        const errMsg =
          statusData.motivo ||
          statusData.xMotivo ||
          statusData.error ||
          statusData.mensagem ||
          'Rejeição no cancelamento pela SEFAZ';
        throw new Error(`SEFAZ rejeitou o cancelamento: ${errMsg}`);
      }
    }

    const finalCheck = await this.getNfeStatus(invoiceId);
    if (finalCheck?.status === 'cancelled') {
      return finalCheck;
    }

    if (finalCheck?.motivo && finalCheck?.status !== 'issued') {
      throw new Error(`Não foi possível confirmar o cancelamento na SEFAZ: ${finalCheck.motivo}`);
    }

    return cancelResponseData || finalCheck;
  }

  /**
   * Cancela o registro de NF-e de remessa em rental_shipping_invoices e no Notaas/SEFAZ
   */
  async cancelShippingInvoiceRecord(shippingInvoiceId: string, motivo: string): Promise<any> {
    const { data: inv, error: fetchErr } = await supabaseAdmin
      .from('rental_shipping_invoices')
      .select('*')
      .eq('id', shippingInvoiceId)
      .single();

    if (fetchErr || !inv) {
      throw new Error('Registro de NF-e de remessa não encontrado.');
    }

    if (inv.status === 'cancelled') {
      return inv;
    }

    if (inv.notaas_invoice_id) {
      await this.cancelNfe(inv.notaas_invoice_id, motivo);
    }

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('rental_shipping_invoices')
      .update({
        status: 'cancelled',
        status_message: `Cancelada: ${(motivo || 'Cancelamento de locação').slice(0, 200)}`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', shippingInvoiceId)
      .select('*')
      .single();

    if (updErr) {
      console.error('[NotaasService] Erro ao atualizar status para cancelled em rental_shipping_invoices:', updErr);
      return { ...inv, status: 'cancelled' };
    }

    return updated;
  }

  /**
   * Executa o ciclo completo de emissão de NF-e de Remessa (Saída) ou Retorno (Entrada):
   * 1. Monta o payload padronizado
   * 2. Envia para o Notaas e aguarda autorização SEFAZ
   * 3. Baixa o XML oficial autorizado
   * 4. Gera o PDF do DANFE Clássico com Canhoto idêntico ao modelo nff.pdf
   * 5. Faz upload no bucket 'fiscal-documents'
   * 6. Registra na tabela 'rental_shipping_invoices'
   */
  async processShippingNfe(params: EmitRemessaParams): Promise<any> {
    const isSaida = params.direction === 'SAIDA';
    const natureName = isSaida
      ? 'REMESSA DE BEM DO ATIVO IMOBILIZADO'
      : 'RETORNO DE BEM DO ATIVO IMOBILIZADO POR LOCACAO';

    const isDestIsento = isClientIsento(params.recipient.state_subscription);
    const destUf = (params.recipient.address_state || 'MT').toUpperCase().trim();
    const isInternal = destUf === 'MT';

    // CFOPs:
    // Saída: 5554 (interno) / 6554 (interestadual)
    // Retorno: 1554 (interno) / 2554 (interestadual)
    const cfop = isSaida ? (isInternal ? '5554' : '6554') : (isInternal ? '1554' : '2554');

    // Validação de equipamentos
    if (!params.equipments || params.equipments.length === 0) {
      throw new Error('Nenhum equipamento fornecido para a nota de remessa.');
    }

    // Monta itens com base em equipments.value
    let totalNota = 0;
    const items = params.equipments.map((eq, idx) => {
      const itemVal = Number(eq.value) > 0 ? Number(eq.value) : 10000; // Fallback se value for 0
      totalNota += itemVal;

      const codeStr = String(idx + 1).padStart(2, '0');
      const desc = `Plataforma elevatoria, PATRIMONIO: ${eq.asset_number || 'S/N'}, modelo ${eq.model || 'N/A'}, série ${eq.serial_number || 'N/A'}`;

      return {
        codigo: codeStr,
        descricao: desc,
        ncm: cleanDigits(eq.ncm) || '84272090',
        cfop,
        unidade: 'UN',
        quantidade: 1,
        valorUnitario: itemVal,
        valorTotal: itemVal,
        icms: {
          csosn: '400', // Não tributada pelo Simples Nacional
        },
      };
    });

    // Resolução segura de "Local da obra" caso não tenha vindo diretamente nos parâmetros
    let effectiveWorkSite = params.workSite?.trim() || '';
    if (!effectiveWorkSite && params.dealContractId) {
      try {
        const { data: ct } = await supabaseAdmin
          .from('crm_deal_contracts')
          .select('snapshot, contract_form_id')
          .eq('id', params.dealContractId)
          .maybeSingle();

        if (ct?.snapshot?.work_site) {
          effectiveWorkSite = String(ct.snapshot.work_site).trim();
        } else if (ct?.contract_form_id) {
          const { data: cf } = await supabaseAdmin
            .from('crm_deal_contract_forms')
            .select('work_site')
            .eq('id', ct.contract_form_id)
            .maybeSingle();
          if (cf?.work_site) {
            effectiveWorkSite = String(cf.work_site).trim();
          }
        }
      } catch (err) {
        console.warn('[NotaasService] Erro ao buscar work_site via dealContractId:', err);
      }
    }

    if (!effectiveWorkSite && params.rentalInvoiceId) {
      try {
        const { data: ctByRental } = await supabaseAdmin
          .from('crm_deal_contracts')
          .select('snapshot, contract_form_id')
          .eq('rental_invoice_id', params.rentalInvoiceId)
          .maybeSingle();

        if (ctByRental?.snapshot?.work_site) {
          effectiveWorkSite = String(ctByRental.snapshot.work_site).trim();
        } else if (ctByRental?.contract_form_id) {
          const { data: cf } = await supabaseAdmin
            .from('crm_deal_contract_forms')
            .select('work_site')
            .eq('id', ctByRental.contract_form_id)
            .maybeSingle();
          if (cf?.work_site) {
            effectiveWorkSite = String(cf.work_site).trim();
          }
        }

        if (!effectiveWorkSite) {
          const { data: inv } = await supabaseAdmin
            .from('rental_invoices')
            .select('work_site')
            .eq('id', params.rentalInvoiceId)
            .maybeSingle();
          if (inv?.work_site) {
            effectiveWorkSite = String(inv.work_site).trim();
          }
        }
      } catch (err) {
        console.warn('[NotaasService] Erro ao buscar work_site via rentalInvoiceId:', err);
      }
    }

    const workSiteStr = effectiveWorkSite ? `Local da obra: ${effectiveWorkSite}. ` : '';
    const infoComplementar = isSaida
      ? `EMPRESA OPTANTE PELO SIMPLES NACIONAL CFE LC 123/2006. ICMS ISENTO CFE ART. 81, ANEXO IV DO RICMS/MT. ${workSiteStr}CONTRATO DE LOCACAO No ${params.contractNumber || 'S/N'}.`
      : `EMPRESA OPTANTE PELO SIMPLES NACIONAL CFE LC 123/2006. ICMS ISENTO CFE ART. 81, ANEXO IV DO RICMS/MT. ${workSiteStr}RETORNO DE LOCACAO CONFORME CONTRATO No ${params.contractNumber || 'S/N'}.`;

    const codigoMunicipio =
      params.recipient.ibge_code ||
      (await resolveIbgeCityCode(params.recipient.address_city, destUf));

    const cleanDoc = cleanDigits(params.recipient.cnpj);
    const destDoc = cleanDoc.length === 11 ? { cpf: cleanDoc } : { cnpj: cleanDoc };
    const cleanIE = cleanDigits(params.recipient.state_subscription);
    const destIE = isDestIsento ? undefined : (cleanIE || params.recipient.state_subscription?.trim());

    // Objeto do destinatário em conformidade estrita com a API do Notaas
    const dest: any = {
      nome: params.recipient.company_name,
      ...destDoc,
      indIEDest: isDestIsento ? 9 : 1,
      indicadorIEDest: isDestIsento ? 9 : 1,
      endereco: {
        logradouro: params.recipient.address_street || 'Avenida Principal',
        numero: params.recipient.address_number || 'SN',
        bairro: params.recipient.address_neighborhood || 'Centro',
        cidade: params.recipient.address_city || 'Cuiaba',
        codigoMunicipio,
        uf: destUf,
        cep: cleanDigits(params.recipient.address_zip) || '78050000',
      },
    };

    // Para destinatário contribuinte (não isento), informa as tags de IE reconhecidas
    if (!isDestIsento && destIE) {
      dest.ie = destIE;
      dest.IE = destIE;
      dest.inscricaoEstadual = destIE;
    }

    const payload: any = {
      modelo: 55,
      tpNF: isSaida ? 1 : 0, // 1 = Saída, 0 = Entrada (retorno)
      naturezaOperacao: natureName,
      dest,
      items,
      pagamentos: [
        {
          tPag: '90', // Sem Pagamento
          vPag: 0.0,
        },
      ],
      infCpl: infoComplementar,
      informacoesComplementares: infoComplementar,
      observacoes: infoComplementar,
    };

    console.log(`[NotaasService] Enviando NF-e (${params.direction}) para o Notaas...`);
    console.log(`[NotaasService] Destinatário payload:`, JSON.stringify({
      nome: dest.nome,
      doc: destDoc,
      ie: dest.ie,
      indIEDest: dest.indIEDest,
      endereco: dest.endereco,
    }));
    const enqueueResult = await this.enqueueNfe(payload);
    const invoiceId = enqueueResult.invoiceId;
    console.log(`[NotaasService] Enfileirado com sucesso, invoiceId: ${invoiceId}`);

    // Polling até autorização
    const authResult = await this.pollUntilTerminal(invoiceId);

    if (authResult.status !== 'issued') {
      const errMsg = authResult.motivo || authResult.xMotivo || authResult.error || authResult.mensagem || 'Falha na autorização da NF-e pela SEFAZ';
      const cStat = authResult.codigoStatus || authResult.cStat || '';
      throw new Error(`SEFAZ Rejeição${cStat ? ` (${cStat})` : ''}: ${errMsg}`);
    }

    console.log(`[NotaasService] NF-e autorizada com sucesso! Protocolo: ${authResult.protocolo || authResult.nProt}`);

    // Baixa o XML oficial nfeProc
    const xmlOfficial = await this.getNfeXml(invoiceId);

    // Renderiza o DANFE Clássico com Canhoto
    console.log(`[NotaasService] Renderizando DANFE clássico SEFAZ com canhoto...`);
    let pdfBuffer: Buffer = Buffer.from('');
    try {
      pdfBuffer = await generateClassicDanfePdfBuffer(xmlOfficial);
    } catch (pdfErr) {
      console.error('[NotaasService] Aviso: Erro ao renderizar DANFE PDF localmente:', pdfErr);
    }

    // Upload no Supabase Storage (fiscal-documents)
    const nfeNum = authResult.numero || authResult.nNf || 1;
    const accessKey = authResult.chaveAcesso || '';
    const cleanNum = String(nfeNum).padStart(6, '0');
    const timestamp = Date.now();

    const pdfStoragePath = `nfe_${params.direction.toLowerCase()}_${cleanNum}_${timestamp}.pdf`;
    const xmlStoragePath = `nfe_${params.direction.toLowerCase()}_${cleanNum}_${timestamp}.xml`;

    let danfePdfUrl = '';
    if (pdfBuffer && pdfBuffer.length > 0) {
      const { error: pdfUploadErr } = await supabaseAdmin.storage
        .from('fiscal-documents')
        .upload(pdfStoragePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });

        if (pdfUploadErr) {
          console.error('[NotaasService] Erro ao fazer upload do PDF no Supabase Storage:', pdfUploadErr);
        } else {
          const { data: pdfUrlData } = supabaseAdmin.storage.from('fiscal-documents').getPublicUrl(pdfStoragePath);
          danfePdfUrl = pdfUrlData?.publicUrl || '';
        }
      }

      const { error: xmlUploadErr } = await supabaseAdmin.storage
        .from('fiscal-documents')
        .upload(xmlStoragePath, Buffer.from(xmlOfficial, 'utf8'), { contentType: 'application/xml', upsert: true });

      if (xmlUploadErr) {
        console.error('[NotaasService] Erro ao fazer upload do XML no Supabase Storage:', xmlUploadErr);
      }

      const { data: xmlUrlData } = supabaseAdmin.storage.from('fiscal-documents').getPublicUrl(xmlStoragePath);
      const xmlUrl = xmlUrlData?.publicUrl || '';

      // Validações e resolução automática de relacionamentos para integridade referencial
      let resolvedRentalInvoiceId = params.rentalInvoiceId || null;
      let resolvedDealContractId = params.dealContractId || null;
      let resolvedUserId = params.userId || null;

      // Se temos o contrato mas não temos o rental_invoice_id, busca no crm_deal_contracts
      if (resolvedDealContractId && !resolvedRentalInvoiceId) {
        const { data: ctData } = await supabaseAdmin
          .from('crm_deal_contracts')
          .select('rental_invoice_id')
          .eq('id', resolvedDealContractId)
          .maybeSingle();
        if (ctData?.rental_invoice_id) {
          resolvedRentalInvoiceId = ctData.rental_invoice_id;
        }
      }

      // Se temos a locação mas não o contrato, busca o contrato vinculado
      if (resolvedRentalInvoiceId && !resolvedDealContractId) {
        const { data: ctData } = await supabaseAdmin
          .from('crm_deal_contracts')
          .select('id')
          .eq('rental_invoice_id', resolvedRentalInvoiceId)
          .maybeSingle();
        if (ctData?.id) {
          resolvedDealContractId = ctData.id;
        }
      }

      // Validar existência real de deal_contract_id para não violar foreign key
      if (resolvedDealContractId) {
        const { data: ctExists } = await supabaseAdmin
          .from('crm_deal_contracts')
          .select('id')
          .eq('id', resolvedDealContractId)
          .maybeSingle();
        if (!ctExists) resolvedDealContractId = null;
      }

      // Validar existência real de rental_invoice_id para não violar foreign key
      if (resolvedRentalInvoiceId) {
        const { data: invExists } = await supabaseAdmin
          .from('rental_invoices')
          .select('id')
          .eq('id', resolvedRentalInvoiceId)
          .maybeSingle();
        if (!invExists) resolvedRentalInvoiceId = null;
      }

      // Validar existência do usuário em users_profiles
      if (resolvedUserId) {
        const { data: userExists } = await supabaseAdmin
          .from('users_profiles')
          .select('id')
          .eq('id', resolvedUserId)
          .maybeSingle();
        if (!userExists) resolvedUserId = null;
      }

      // Validar formato UUID do invoiceId do Notaas
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const resolvedNotaasInvoiceId = invoiceId && uuidRegex.test(invoiceId) ? invoiceId : null;

      // Salvar registro na tabela rental_shipping_invoices
      let shippingInvoice: any = null;
      const invoicePayloadToInsert = {
        rental_invoice_id: resolvedRentalInvoiceId,
        deal_contract_id: resolvedDealContractId,
        direction: params.direction,
        issuer_type: 'SISTEMA_NOTAAS',
        nfe_number: nfeNum,
        serie: authResult.serie || 1,
        access_key: accessKey,
        protocol: authResult.protocolo || authResult.nProt || null,
        notaas_invoice_id: resolvedNotaasInvoiceId,
        status: 'issued',
        status_code: authResult.codigoStatus || authResult.cStat || 100,
        status_message: authResult.motivo || authResult.xMotivo || 'Autorizado o uso da NF-e',
        natureza_operacao: natureName,
        total_value: totalNota,
        cfop,
        danfe_pdf_url: danfePdfUrl,
        xml_url: xmlUrl,
        created_by: resolvedUserId,
      };

      const { data: insertedData, error: dbErr } = await supabaseAdmin
        .from('rental_shipping_invoices')
        .insert(invoicePayloadToInsert)
        .select('*')
        .single();

      if (dbErr) {
        console.error('[NotaasService] Erro ao registrar rental_shipping_invoices:', dbErr);
        // Tentativa de inserção resiliente de fallback (sem foreign keys opcionais) para nunca perder a nota emitida
        const { data: fallbackData, error: fallbackErr } = await supabaseAdmin
          .from('rental_shipping_invoices')
          .insert({
            ...invoicePayloadToInsert,
            deal_contract_id: null,
            rental_invoice_id: null,
            created_by: null,
          })
          .select('*')
          .single();

        if (fallbackErr) {
          console.error('[NotaasService] Erro fatal no fallback de rental_shipping_invoices:', fallbackErr);
        } else {
          shippingInvoice = fallbackData;
          console.log('[NotaasService] Registro salvo com sucesso via fallback resiliente.');
        }
      } else {
        shippingInvoice = insertedData;
        console.log(`[NotaasService] Registro fiscal salvo em rental_shipping_invoices (ID: ${shippingInvoice.id})`);
      }

      return {
        shippingInvoice,
        danfePdfUrl,
        xmlUrl,
        pdfBase64: pdfBuffer.toString('base64'),
        accessKey,
        protocol: authResult.protocolo || authResult.nProt,
        nfeNumber: nfeNum,
      };
    }
  }

  export const notaasService = new NotaasService();

