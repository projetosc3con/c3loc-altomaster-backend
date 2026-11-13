import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { getSupabaseUserClient, supabaseAdmin } from '../config/supabase';
import { notaasService, isClientIsento } from '../services/notaasService';

/**
 * POST /api/fiscal/shipping/saida/:contractId
 * Emite a NF-e de Remessa de Saída para o contrato processado/triado
 */
export async function emitShippingNfeSaida(req: AuthRequest, res: Response) {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const contractId = Array.isArray(req.params.contractId) ? req.params.contractId[0] : req.params.contractId;

    // 1. Buscar contrato com supabaseAdmin para evitar inconsistência de RLS
    const { data: contract, error: contractErr } = await supabaseAdmin
      .from('crm_deal_contracts')
      .select('*')
      .eq('id', contractId)
      .single();

    if (contractErr || !contract) {
      return res.status(404).json({ error: 'Contrato não encontrado.' });
    }

    // Buscar contract_form se contract_form_id estiver presente
    let contractForm: any = null;
    if (contract.contract_form_id) {
      const { data: cf } = await supabaseAdmin
        .from('crm_deal_contract_forms')
        .select('*')
        .eq('id', contract.contract_form_id)
        .maybeSingle();
      contractForm = cf;
    }

    // 2. Buscar locação vinculada
    let rentalInvoiceId = contract.rental_invoice_id;
    let rentalInvoice: any = null;
    if (rentalInvoiceId) {
      const { data: inv } = await supabaseAdmin
        .from('rental_invoices')
        .select('*')
        .eq('id', rentalInvoiceId)
        .single();
      rentalInvoice = inv;
    }

    // 3. Buscar equipamentos triados (rental_invoice_equipments ou fallback snapshot)
    let equipments: any[] = [];
    if (rentalInvoiceId) {
      const { data: eqItems } = await supabaseAdmin
        .from('rental_invoice_equipments')
        .select('*')
        .or(`deal_contract_id.eq.${contractId},rental_invoice_id.eq.${rentalInvoiceId}`);
      if (eqItems && eqItems.length > 0) {
        equipments = eqItems;
      }
    }

    if (equipments.length === 0 && contract.snapshot?.equipments) {
      equipments = contract.snapshot.equipments;
    }

    // Enriquecer equipamentos com equipments.value se disponível
    const enrichedEquipments = await Promise.all(
      equipments.map(async (eq) => {
        let val = Number(eq.value) || 0;
        let ncm = eq.ncm || '84272090';
        let model = eq.model;
        let serial = eq.serial_number;
        let asset = eq.asset_number;

        if (eq.equipment_id) {
          const { data: masterEq } = await supabaseAdmin
            .from('equipments')
            .select('value, ncm, model, serial_number, asset_number')
            .eq('id', eq.equipment_id)
            .single();

          if (masterEq) {
            val = Number(masterEq.value) > 0 ? Number(masterEq.value) : val;
            ncm = masterEq.ncm || ncm;
            model = masterEq.model || model;
            serial = masterEq.serial_number || serial;
            asset = masterEq.asset_number || asset;
          }
        }

        return {
          equipment_id: eq.equipment_id,
          asset_number: asset,
          equipment_name: eq.equipment_name || 'Plataforma Elevatória',
          model: model || 'N/A',
          serial_number: serial || 'N/A',
          ncm,
          value: val > 0 ? val : 330000, // Fallback do padrão de máquina
        };
      })
    );

    // 4. Buscar dados do cliente / destinatário com resolução profunda
    const form = contractForm || contract.contract_form || contract.snapshot?.contract_form || {};
    let clientId = contract.client_id || rentalInvoice?.client_id;
    let client: any = null;

    // Se clientId ainda não estiver no contrato, busca pelo deal_id
    if (!clientId && contract.deal_id) {
      const { data: deal } = await supabaseAdmin
        .from('crm_deals')
        .select('client_id')
        .eq('id', contract.deal_id)
        .maybeSingle();
      if (deal?.client_id) {
        clientId = deal.client_id;
      }
    }

    if (clientId) {
      const { data: cl } = await supabaseAdmin
        .from('clients')
        .select('*')
        .eq('id', clientId)
        .maybeSingle();
      client = cl;
    }

    const cnpj = form.locatario_cnpj || client?.cnpj || rentalInvoice?.cnpj || '';
    if (!client && cnpj) {
      const cleanCnpj = cnpj.replace(/\D/g, '');
      const { data: clByCnpj } = await supabaseAdmin
        .from('clients')
        .select('*')
        .or(`cnpj.eq.${cnpj},cnpj.eq.${cleanCnpj}`)
        .maybeSingle();
      if (clByCnpj) client = clByCnpj;
    }

    const companyName = client?.company_name || form.locatario_company_name || rentalInvoice?.client_name || 'Cliente';
    const stateSub =
      client?.state_subscription ||
      form.locatario_state_registration ||
      form.locatario_state_subscription ||
      form.state_subscription ||
      form.state_registration ||
      rentalInvoice?.state_subscription ||
      '';
    let street = client?.address_street || form.locatario_address || '';
    let number = client?.address_number || form.locatario_number || '';
    let neighborhood = client?.address_neighborhood || form.locatario_neighborhood || '';
    let city = client?.address_city || form.locatario_city || '';
    let uf = client?.address_state || form.locatario_state || '';
    let zip = client?.address_zip || form.locatario_zip || '';

    // Se endereço estruturado estiver incompleto mas houver locatario_address_full, extrair via regex
    if ((!street || !city) && form.locatario_address_full) {
      const full = String(form.locatario_address_full).trim();
      const match = full.match(/^(.*?)(?:,\s*(\d+|SN|S\/N))?(?:\s*-\s*(.*?))?(?:\/([A-Z]{2}))?$/i);
      if (match) {
        if (!street) street = match[1]?.trim() || '';
        if (!number) number = match[2]?.trim() || 'SN';
        if (!city && match[3]) city = match[3]?.trim() || '';
        if (!uf && match[4]) uf = match[4]?.toUpperCase().trim() || '';
      }
    }

    street = street || 'Avenida Principal';
    number = number || 'SN';
    neighborhood = neighborhood || 'Centro';
    city = city || 'Cuiaba';
    uf = (uf || 'MT').toUpperCase().trim();
    zip = zip || '78050000';

    const workSite =
      contract.snapshot?.work_site ||
      contractForm?.work_site ||
      contract.snapshot?.contract_form?.work_site ||
      form.work_site ||
      rentalInvoice?.work_site ||
      '';

    // Se temos rental_invoices mas work_site não estava preenchido ou mudou, atualiza
    if (rentalInvoiceId && workSite && rentalInvoice?.work_site !== workSite) {
      await supabaseAdmin
        .from('rental_invoices')
        .update({ work_site: workSite })
        .eq('id', rentalInvoiceId);
    }

    console.log('[emitShippingNfeSaida] Destinatário resolvido:', {
      contractNumber: contract.contract_number,
      companyName,
      cnpj,
      stateSub,
      city,
      uf,
      workSite,
    });

    const result = await notaasService.processShippingNfe({
      direction: 'SAIDA',
      dealContractId: contractId,
      rentalInvoiceId: rentalInvoiceId || undefined,
      contractNumber: contract.contract_number,
      workSite,
      recipient: {
        company_name: companyName,
        cnpj,
        state_subscription: stateSub,
        address_street: street,
        address_number: number,
        address_neighborhood: neighborhood,
        address_city: city,
        address_state: uf,
        address_zip: zip,
      },
      equipments: enrichedEquipments,
      userId: req.user?.id,
    });

    return res.json(result);
  } catch (error: any) {
    console.error('[emitShippingNfeSaida] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao emitir NF-e de remessa de saída.' });
  }
}

/**
 * Lógica reutilizável para emitir NF-e de Retorno (Entrada) de uma locação
 */
export async function executeEmitShippingNfeRetorno(
  rentalId: string,
  userId?: string,
  options?: { forceSystemEmit?: boolean }
): Promise<any> {
  const { data: rental, error: rentalErr } = await supabaseAdmin
    .from('rental_invoices')
    .select('*')
    .eq('id', rentalId)
    .single();

  if (rentalErr || !rental) {
    throw new Error('Locação não encontrada.');
  }

  // 1. Buscar cliente e verificar se é isento
  let client: any = null;
  if (rental.client_id) {
    const { data: cl } = await supabaseAdmin
      .from('clients')
      .select('*')
      .eq('id', rental.client_id)
      .maybeSingle();
    client = cl;
  }

  if (!client && rental.cnpj) {
    const cleanCnpj = rental.cnpj.replace(/\D/g, '');
    const { data: clByCnpj } = await supabaseAdmin
      .from('clients')
      .select('*')
      .or(`cnpj.eq.${rental.cnpj},cnpj.eq.${cleanCnpj}`)
      .maybeSingle();
    if (clByCnpj) client = clByCnpj;
  }

  const stateSub = client?.state_subscription || rental.state_subscription || '';
  if (!options?.forceSystemEmit && !isClientIsento(stateSub)) {
    throw new Error(
      `Cliente possui Inscrição Estadual ativa (${stateSub}). A NF-e de retorno deve ser emitida pelo próprio cliente.`
    );
  }

  // 2. Buscar equipamentos da locação (deduplicando máquinas físicas únicas)
  const { data: eqItems } = await supabaseAdmin
    .from('rental_invoice_equipments')
    .select('*')
    .eq('rental_invoice_id', rentalId);

  const rawEquipmentsList = eqItems && eqItems.length > 0 ? eqItems : [rental];
  const uniqueEquipmentsMap = new Map<string, any>();
  for (const eq of rawEquipmentsList) {
    const key = eq.equipment_id || eq.asset_number || eq.id || String(uniqueEquipmentsMap.size);
    uniqueEquipmentsMap.set(key, eq);
  }
  const equipmentsList = Array.from(uniqueEquipmentsMap.values());

  const enrichedEquipments = await Promise.all(
    equipmentsList.map(async (eq) => {
      let val = Number(eq.value) || 0;
      let ncm = eq.ncm || '84272090';
      let model = eq.model;
      let serial = eq.serial_number;
      let asset = eq.asset_number;

      if (eq.equipment_id) {
        const { data: masterEq } = await supabaseAdmin
          .from('equipments')
          .select('value, ncm, model, serial_number, asset_number')
          .eq('id', eq.equipment_id)
          .single();

        if (masterEq) {
          val = Number(masterEq.value) > 0 ? Number(masterEq.value) : val;
          ncm = masterEq.ncm || ncm;
          model = masterEq.model || model;
          serial = masterEq.serial_number || serial;
          asset = masterEq.asset_number || asset;
        }
      }

      return {
        equipment_id: eq.equipment_id,
        asset_number: asset,
        equipment_name: eq.equipment_name || 'Plataforma Elevatória',
        model: model || 'N/A',
        serial_number: serial || 'N/A',
        ncm,
        value: val > 0 ? val : 330000,
      };
    })
  );

  // 3. Buscar contrato vinculado em crm_deal_contracts para obter ID, dados da obra e número do contrato
  let dealContractId: string | undefined = undefined;
  let contractNumber: string = rental.invoice_number;

  const { data: ctByRental } = await supabaseAdmin
    .from('crm_deal_contracts')
    .select('id, snapshot, contract_form_id, contract_number')
    .eq('rental_invoice_id', rentalId)
    .maybeSingle();

  let contractObj = ctByRental;
  if (!contractObj && rental.deal_id) {
    const { data: ctByDeal } = await supabaseAdmin
      .from('crm_deal_contracts')
      .select('id, snapshot, contract_form_id, contract_number')
      .eq('deal_id', rental.deal_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    contractObj = ctByDeal;
  }

  if (!contractObj) {
    const { data: saidaInvoice } = await supabaseAdmin
      .from('rental_shipping_invoices')
      .select('deal_contract_id')
      .eq('rental_invoice_id', rentalId)
      .not('deal_contract_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (saidaInvoice?.deal_contract_id) {
      const { data: ctById } = await supabaseAdmin
        .from('crm_deal_contracts')
        .select('id, snapshot, contract_form_id, contract_number')
        .eq('id', saidaInvoice.deal_contract_id)
        .maybeSingle();
      contractObj = ctById;
    }
  }

  let workSite = '';
  let contractForm: any = null;
  if (contractObj) {
    dealContractId = contractObj.id;
    if (contractObj.contract_number) {
      contractNumber = contractObj.contract_number;
    }

    if (contractObj.contract_form_id) {
      const { data: cf } = await supabaseAdmin
        .from('crm_deal_contract_forms')
        .select('*')
        .eq('id', contractObj.contract_form_id)
        .maybeSingle();
      contractForm = cf;
    }

    if (contractObj.snapshot?.work_site) {
      workSite = contractObj.snapshot.work_site;
    } else if (contractObj.snapshot?.contract_form?.work_site) {
      workSite = contractObj.snapshot.contract_form.work_site;
    } else if (contractForm?.work_site) {
      workSite = contractForm.work_site;
    }
  }

  if (!workSite && rental.work_site) {
    workSite = rental.work_site;
  }

  if (workSite && rental.work_site !== workSite) {
    await supabaseAdmin
      .from('rental_invoices')
      .update({ work_site: workSite })
      .eq('id', rentalId);
  }

  const form = contractForm || contractObj?.snapshot?.contract_form || {};

  return notaasService.processShippingNfe({
    direction: 'RETORNO',
    rentalInvoiceId: rentalId,
    dealContractId,
    contractNumber,
    workSite,
    recipient: {
      company_name: client?.company_name || form.locatario_company_name || rental.client_name || 'Cliente',
      cnpj: client?.cnpj || form.locatario_cnpj || rental.cnpj || '',
      state_subscription: stateSub || form.locatario_state_registration || form.locatario_state_subscription || '',
      address_street: client?.address_street || form.locatario_address || 'Avenida Principal',
      address_number: client?.address_number || form.locatario_number || 'SN',
      address_neighborhood: client?.address_neighborhood || form.locatario_neighborhood || 'Centro',
      address_city: client?.address_city || form.locatario_city || 'Cuiaba',
      address_state: client?.address_state || form.locatario_state || 'MT',
      address_zip: client?.address_zip || form.locatario_zip || '78050000',
    },
    equipments: enrichedEquipments,
    userId,
  });
}

/**
 * POST /api/fiscal/shipping/retorno/:rentalId
 * Emite a NF-e de Retorno (Entrada) pelo sistema se o cliente for ISENTO (ou quando forceSystemEmit = true)
 */
export async function emitShippingNfeRetorno(req: AuthRequest, res: Response) {
  try {
    const rentalId = Array.isArray(req.params.rentalId) ? req.params.rentalId[0] : req.params.rentalId;
    const forceSystemEmit = Boolean(req.body?.forceSystemEmit);
    const result = await executeEmitShippingNfeRetorno(rentalId, req.user?.id, { forceSystemEmit });
    return res.json(result);
  } catch (error: any) {
    console.error('[emitShippingNfeRetorno] Erro:', error);
    const isClientRuleErr = error.message?.includes('Inscrição Estadual ativa');
    return res.status(isClientRuleErr ? 400 : 500).json({ error: error.message || 'Erro ao emitir NF-e de retorno.' });
  }
}

/**
 * POST /api/fiscal/shipping/cancel/:shippingInvoiceId
 * Cancela uma NF-e de remessa junto à SEFAZ via Notaas
 */
export async function cancelShippingNfe(req: AuthRequest, res: Response) {
  try {
    const rawId = req.params.shippingInvoiceId;
    const shippingInvoiceId = Array.isArray(rawId) ? rawId[0] : rawId;
    const { motivo } = req.body || {};

    const updated = await notaasService.cancelShippingInvoiceRecord(
      shippingInvoiceId,
      motivo || 'Cancelamento da locacao antes da saida fisica do equipamento'
    );
    return res.json(updated);
  } catch (error: any) {
    console.error('[cancelShippingNfe] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao cancelar NF-e de remessa.' });
  }
}

/**
 * POST /api/fiscal/shipping/retorno-externo/:rentalId
 * Registra uma NF-e de Retorno emitida diretamente pelo cliente (com IE)
 */
export async function registerExternalShippingNfe(req: AuthRequest, res: Response) {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const rentalId = Array.isArray(req.params.rentalId) ? req.params.rentalId[0] : req.params.rentalId;
    const { access_key, nfe_number, danfe_pdf_url } = req.body;

    if (!access_key && !danfe_pdf_url) {
      return res.status(400).json({ error: 'Informe a Chave de Acesso ou a URL do DANFE da nota do cliente.' });
    }

    const { data: record, error: dbErr } = await supabase
      .from('rental_shipping_invoices')
      .insert({
        rental_invoice_id: rentalId,
        direction: 'RETORNO',
        issuer_type: 'CLIENTE_EXTERNO',
        nfe_number: nfe_number ? Number(nfe_number) : null,
        access_key: access_key?.replace(/\D/g, '') || null,
        status: 'issued',
        natureza_operacao: 'RETORNO DE BEM DO ATIVO IMOBILIZADO POR LOCACAO (CLIENTE)',
        cfop: '1554',
        danfe_pdf_url: danfe_pdf_url || null,
        created_by: req.user?.id || null,
      })
      .select('*')
      .single();

    if (dbErr) throw dbErr;
    return res.json(record);
  } catch (error: any) {
    console.error('[registerExternalShippingNfe] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao registrar NF-e externa de retorno.' });
  }
}

/**
 * GET /api/fiscal/shipping/documents/:rentalOrContractId
 * Retorna todos os documentos fiscais de remessa/retorno vinculados à locação ou contrato
 */
export async function getShippingDocuments(req: AuthRequest, res: Response) {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const rawTarget = req.params.rentalOrContractId;
    const targetId = Array.isArray(rawTarget) ? rawTarget[0] : rawTarget;

    if (!targetId) {
      return res.json([]);
    }

    // Coletar todos os possíveis IDs relacionados (locação e contrato)
    const rentalIds = new Set<string>();
    const contractIds = new Set<string>();

    rentalIds.add(targetId);
    contractIds.add(targetId);

    // 1. Se targetId for um contrato, buscar a locação vinculada
    const { data: contract } = await supabase
      .from('crm_deal_contracts')
      .select('id, rental_invoice_id, deal_id')
      .eq('id', targetId)
      .maybeSingle();

    if (contract?.rental_invoice_id) {
      rentalIds.add(contract.rental_invoice_id);
    }

    // 2. Se targetId for uma locação, buscar contratos vinculados (por rental_invoice_id ou deal_id)
    const { data: linkedByRental } = await supabase
      .from('crm_deal_contracts')
      .select('id')
      .eq('rental_invoice_id', targetId);

    if (linkedByRental && linkedByRental.length > 0) {
      linkedByRental.forEach((c) => contractIds.add(c.id));
    }

    const { data: rental } = await supabase
      .from('rental_invoices')
      .select('id, deal_id')
      .eq('id', targetId)
      .maybeSingle();

    if (rental?.deal_id) {
      const { data: dealContracts } = await supabase
        .from('crm_deal_contracts')
        .select('id')
        .eq('deal_id', rental.deal_id);

      if (dealContracts) {
        dealContracts.forEach((c) => contractIds.add(c.id));
      }
    }

    // Montar condições OR seguras
    const orClauses: string[] = [];
    rentalIds.forEach((rId) => orClauses.push(`rental_invoice_id.eq.${rId}`));
    contractIds.forEach((cId) => orClauses.push(`deal_contract_id.eq.${cId}`));

    const { data: docs, error } = await supabase
      .from('rental_shipping_invoices')
      .select('*')
      .or(orClauses.join(','))
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(docs || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
}
