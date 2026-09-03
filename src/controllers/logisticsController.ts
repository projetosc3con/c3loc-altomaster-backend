import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { getSupabaseUserClient } from '../config/supabase';

/**
 * GET /api/logistics/contracts
 * Returns all contracts with status in ['Assinado', 'Triagem', 'Processado']
 * enriched with deal + contract_form data for the logistics board.
 */
export const getAllContracts = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);

    const { data, error } = await supabase
      .from('crm_deal_contracts')
      .select(`
        *,
        deal:crm_deals!crm_deal_contracts_deal_id_fkey(
          id,
          title,
          value,
          client:clients(id, company_name, cnpj),
          lead:crm_leads(id, company_name)
        ),
        contract_form:crm_deal_contract_forms(
          equipment_description,
          equipment_model,
          work_site,
          locatario_company_name,
          locatario_cnpj,
          cost_total,
          period_start,
          period_end
        )
      `)
      .in('status', ['Assinado', 'Triagem', 'Processado'])
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('[logisticsController] Erro em getAllContracts:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor' });
  }
};

/**
 * GET /api/logistics/contracts/:id
 * Returns a single contract with full deal, contract_form and client data
 * for the triage page.
 */
// Helper para extrair equipamentos pretendidos definidos no contrato
const extractContractIntendedEquipments = async (supabase: any, contract: any): Promise<any[]> => {
  // 1. Snapshot com lista de equipamentos
  if (contract?.snapshot?.equipments && Array.isArray(contract.snapshot.equipments) && contract.snapshot.equipments.length > 0) {
    return contract.snapshot.equipments;
  }
  // 2. Snapshot legado com equipment.items
  if (contract?.snapshot?.equipment?.items && Array.isArray(contract.snapshot.equipment.items) && contract.snapshot.equipment.items.length > 0) {
    return contract.snapshot.equipment.items;
  }
  // 3. Formulário de contrato com JSON em equipment_model
  const equipModel = contract?.contract_form?.equipment_model;
  if (equipModel && typeof equipModel === 'string' && equipModel.startsWith('[EQUIPMENTS_JSON]:')) {
    try {
      const parsed = JSON.parse(equipModel.replace('[EQUIPMENTS_JSON]:', ''));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) {
      // Ignorar erro de parse
    }
  }
  // 4. Se houver fatura vinculada à negociação ou contrato
  const dealRentalInvoiceId = contract?.deal?.rental_invoice_id || contract?.rental_invoice_id;
  if (dealRentalInvoiceId) {
    const { data: invEquips } = await supabase
      .from('rental_invoice_equipments')
      .select('*')
      .eq('rental_invoice_id', dealRentalInvoiceId)
      .order('created_at', { ascending: true });
    if (invEquips && invEquips.length > 0) {
      return invEquips.map((e: any) => ({
        tempId: e.id,
        equipment_id: e.equipment_id,
        equipment_name: e.equipment_name || '',
        equipment_type: e.equipment_type || '',
        equipment_size: e.equipment_size || '',
        asset_number: e.asset_number || '',
        billing_period_start: e.billing_period_start ? String(e.billing_period_start).split('T')[0] : '',
        billing_period_end: e.billing_period_end ? String(e.billing_period_end).split('T')[0] : '',
        cost_rental: Number(e.cost_rental) || 0,
        cost_insurance: Number(e.cost_insurance) || 0,
        cost_freight: Number(e.cost_freight) || 0,
        cost_rcd: Number(e.cost_rcd) || 0,
        cost_third_party: Number(e.cost_third_party) || 0,
        cost_training: Number(e.cost_training) || 0,
        total_value: Number(e.total_value) || 0
      }));
    }
  }
  // 5. Fallback com único equipamento do formulário ou snapshot
  const form = contract?.contract_form || {};
  const snap = contract?.snapshot || {};
  return [{
    tempId: 'intended-1',
    equipment_name: form.equipment_description || snap.equipment?.description || 'Equipamento',
    equipment_size: '',
    billing_period_start: form.period_start || snap.period_start || '',
    billing_period_end: form.period_end || snap.period_end || '',
    cost_rental: Number(form.cost_rental ?? snap.costs?.rental ?? 0),
    cost_insurance: Number(form.cost_insurance ?? snap.costs?.insurance ?? 0),
    cost_freight: Number(form.cost_freight ?? snap.costs?.freight ?? 0),
    cost_rcd: Number(form.cost_rcd ?? snap.costs?.rcd ?? 0),
    cost_third_party: Number(form.cost_third_party ?? snap.costs?.third_party ?? 0),
    cost_training: Number(form.cost_training ?? snap.costs?.training ?? 0),
    total_value: Number(form.cost_total ?? snap.costs?.total ?? contract?.deal?.value ?? 0)
  }];
};

/**
 * GET /api/logistics/contracts/:id
 * Returns a single contract with full deal, contract_form and client data
 * for the triage page.
 */
export const getContractById = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { id } = req.params;

    const { data, error } = await supabase
      .from('crm_deal_contracts')
      .select(`
        *,
        deal:crm_deals!crm_deal_contracts_deal_id_fkey(
          id,
          title,
          value,
          expected_close_date,
          client_id,
          client:clients(id, company_name, cnpj, address_street, address_number, address_city, address_state),
          lead:crm_leads(id, company_name, cnpj)
        ),
        contract_form:crm_deal_contract_forms(*)
      `)
      .eq('id', id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Contrato não encontrado' });

    const intendedEquipments = await extractContractIntendedEquipments(supabase, data);

    res.json({
      ...data,
      intended_equipments: intendedEquipments
    });
  } catch (error: any) {
    console.error('[logisticsController] Erro em getContractById:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor' });
  }
};

/**
 * PATCH /api/logistics/contracts/:id/start-triage
 * Updates contract status from 'Assinado' to 'Triagem'.
 */
export const startTriage = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { id } = req.params;

    // Verify current status
    const { data: contract, error: fetchError } = await supabase
      .from('crm_deal_contracts')
      .select('status')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;
    if (!contract) return res.status(404).json({ error: 'Contrato não encontrado' });

    if (contract.status !== 'Assinado') {
      return res.status(400).json({ error: 'Apenas contratos com status "Assinado" podem iniciar triagem.' });
    }

    const { data, error } = await supabase
      .from('crm_deal_contracts')
      .update({
        status: 'Triagem',
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('[logisticsController] Erro em startTriage:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor' });
  }
};

/**
 * PATCH /api/logistics/contracts/:id/finish
 * Updates contract status from 'Triagem' to 'Processado' and sets rental_invoice_id.
 */
export const finishProcessing = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { id } = req.params;
    const {
      equipment_id,
      equipments: rawEquipments,
      billing_method = 'ASAAS',
      manual_due_date,
      document_type = 'FATURA_LOCACAO',
      fatura_pdf_url,
    } = req.body;

    // Fetch contract with full relationship data
    const { data: contract, error: fetchError } = await supabase
      .from('crm_deal_contracts')
      .select(`
        *,
        deal:crm_deals!crm_deal_contracts_deal_id_fkey(
          id, title, value, client_id, lead_id,
          client:clients(id, company_name, cnpj, asaas_customer_id, email, phone, address_street, address_number, address_city, address_state),
          lead:crm_leads(id, company_name, cnpj)
        ),
        contract_form:crm_deal_contract_forms(*)
      `)
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;
    if (!contract) return res.status(404).json({ error: 'Contrato não encontrado' });

    if (contract.status !== 'Triagem') {
      return res.status(400).json({ error: 'Apenas contratos em "Triagem" podem ser finalizados.' });
    }

    const form = contract.contract_form || {};
    const deal = contract.deal || {};
    const client = deal.client || {};
    const lead = deal.lead || {};

    const resolvedClientId = client.id || deal.client_id || null;
    if (!resolvedClientId) {
      return res.status(400).json({
        error: 'Este contrato está vinculado a um Lead, não a um Cliente. Converta o Lead em Cliente (CRM → Leads → Converter) antes de finalizar o processamento.'
      });
    }

    // Normalizar lista de equipamentos triados
    let equipmentsList: any[] = [];
    if (Array.isArray(rawEquipments) && rawEquipments.length > 0) {
      equipmentsList = rawEquipments;
    } else if (equipment_id) {
      equipmentsList = [{
        equipment_id,
        billing_period_start: form.period_start || null,
        billing_period_end: form.period_end || null,
        cost_rental: Number(form.cost_rental) || 0,
        cost_insurance: Number(form.cost_insurance) || 0,
        cost_freight: Number(form.cost_freight) || 0,
        cost_rcd: Number(form.cost_rcd) || 0,
        cost_third_party: Number(form.cost_third_party) || 0,
        cost_training: Number(form.cost_training) || 0,
        total_value: Number(form.cost_total) || 0
      }];
    }

    // Buscar dados complementares dos equipamentos do estoque
    const equipmentIds = equipmentsList.map(e => e.equipment_id).filter(Boolean);
    let equipmentsDbMap = new Map<string, any>();
    if (equipmentIds.length > 0) {
      const { data: dbEqs } = await supabase
        .from('equipments')
        .select('id, name, type, asset_number, model')
        .in('id', equipmentIds);
      if (dbEqs) {
        dbEqs.forEach(eq => equipmentsDbMap.set(eq.id, eq));
      }
    }

    // Enriquecer equipmentsList com dados do banco
    equipmentsList = equipmentsList.map(item => {
      const dbEq = item.equipment_id ? equipmentsDbMap.get(item.equipment_id) : null;
      return {
        ...item,
        equipment_name: dbEq?.name || item.equipment_name || item.name || form.equipment_description || 'Equipamento',
        equipment_type: dbEq?.type || item.equipment_type || item.type || null,
        asset_number: dbEq?.asset_number || item.asset_number || null,
        billing_period_start: item.billing_period_start || form.period_start || null,
        billing_period_end: item.billing_period_end || form.period_end || null,
        cost_rental: Number(item.cost_rental) || 0,
        cost_insurance: Number(item.cost_insurance) || 0,
        cost_freight: Number(item.cost_freight) || 0,
        cost_rcd: Number(item.cost_rcd) || 0,
        cost_third_party: Number(item.cost_third_party) || 0,
        cost_training: Number(item.cost_training) || 0,
        total_value: Number(item.total_value) || (
          (Number(item.cost_rental) || 0) +
          (Number(item.cost_insurance) || 0) +
          (Number(item.cost_freight) || 0) +
          (Number(item.cost_rcd) || 0) +
          (Number(item.cost_third_party) || 0) +
          (Number(item.cost_training) || 0)
        )
      };
    });

    // Calcular totais e datas consolidadas
    const starts = equipmentsList.map(e => e.billing_period_start).filter(Boolean).sort();
    const ends = equipmentsList.map(e => e.billing_period_end).filter(Boolean).sort();
    const earliestStart = starts.length > 0 ? starts[0] : (form.period_start || null);
    const latestEnd = ends.length > 0 ? ends[ends.length - 1] : (form.period_end || null);

    const consolidatedCostRental = equipmentsList.reduce((acc, e) => acc + (Number(e.cost_rental) || 0), 0);
    const consolidatedCostInsurance = equipmentsList.reduce((acc, e) => acc + (Number(e.cost_insurance) || 0), 0);
    const consolidatedCostFreight = equipmentsList.reduce((acc, e) => acc + (Number(e.cost_freight) || 0), 0);
    const consolidatedCostRcd = equipmentsList.reduce((acc, e) => acc + (Number(e.cost_rcd) || 0), 0);
    const consolidatedCostThirdParty = equipmentsList.reduce((acc, e) => acc + (Number(e.cost_third_party) || 0), 0);
    const consolidatedCostTraining = equipmentsList.reduce((acc, e) => acc + (Number(e.cost_training) || 0), 0);
    const calculatedTotal = equipmentsList.reduce((acc, e) => acc + (Number(e.total_value) || 0), 0);
    const totalValue = calculatedTotal > 0 ? calculatedTotal : (Number(form.cost_total) || 0);

    const firstEq = equipmentsList[0] || {};
    const equipmentNamesSummary = equipmentsList
      .map(e => e.asset_number ? `[${e.asset_number}] ${e.equipment_name}` : e.equipment_name)
      .join(', ');

    const finalDueDate = (billing_method === 'MANUAL' && manual_due_date)
      ? manual_due_date
      : (latestEnd || form.period_end || null);

    // 1. Create the rental invoice
    const invoicePayload = {
      client_id: resolvedClientId,
      client_name: form.locatario_company_name || lead.company_name || client.company_name || 'N/A',
      cnpj: form.locatario_cnpj || lead.cnpj || client.cnpj || null,
      equipment_id: firstEq.equipment_id || null,
      equipment_name: equipmentNamesSummary || firstEq.equipment_name || form.equipment_description || 'N/A',
      equipment_type: firstEq.equipment_type || null,
      asset_number: firstEq.asset_number || null,
      work_site: form.work_site || null,
      billing_period_start: earliestStart,
      billing_period_end: latestEnd,
      payment_method: billing_method === 'MANUAL' ? 'MANUAL' : 'BOLETO',
      billing_method,
      document_type,
      manual_due_date: manual_due_date || null,
      fatura_pdf_url: fatura_pdf_url || null,
      cost_rental: consolidatedCostRental || form.cost_rental || 0,
      cost_insurance: consolidatedCostInsurance || form.cost_insurance || 0,
      cost_freight: consolidatedCostFreight || form.cost_freight || 0,
      cost_rcd: consolidatedCostRcd || form.cost_rcd || 0,
      cost_third_party: consolidatedCostThirdParty || form.cost_third_party || 0,
      cost_training: consolidatedCostTraining || form.cost_training || 0,
      total_value: totalValue,
      due_date: finalDueDate,
      billing_status: billing_method === 'MANUAL' ? 'Faturado' : 'Pendente',
      reconciliation_status: 'Atrasado',
      created_by: req.user?.id || null
    };

    const { data: newInvoice, error: invoiceError } = await supabase
      .from('rental_invoices')
      .insert([invoicePayload])
      .select()
      .single();

    if (invoiceError) throw invoiceError;

    // 2. Inserir múltiplos equipamentos em rental_invoice_equipments
    if (equipmentsList.length > 0) {
      const invoiceEquipmentsToInsert = equipmentsList.map(item => ({
        rental_invoice_id: newInvoice.id,
        deal_contract_id: id,
        equipment_id: item.equipment_id || null,
        equipment_name: item.equipment_name || 'Equipamento',
        equipment_type: item.equipment_type || null,
        equipment_size: item.equipment_size || '',
        asset_number: item.asset_number || null,
        billing_period_start: item.billing_period_start,
        billing_period_end: item.billing_period_end,
        cost_rental: Number(item.cost_rental) || 0,
        cost_insurance: Number(item.cost_insurance) || 0,
        cost_freight: Number(item.cost_freight) || 0,
        cost_rcd: Number(item.cost_rcd) || 0,
        cost_third_party: Number(item.cost_third_party) || 0,
        cost_training: Number(item.cost_training) || 0,
        total_value: Number(item.total_value) || 0
      }));

      const { error: rEquipError } = await supabase
        .from('rental_invoice_equipments')
        .insert(invoiceEquipmentsToInsert);

      if (rEquipError) {
        console.error('[logisticsController] Erro ao inserir rental_invoice_equipments:', rEquipError);
      }
    }

    // Se for faturamento manual, gera lançamento automático em bills (contas a receber)
    if (billing_method === 'MANUAL') {
      const clientDisplayName = form.locatario_company_name || client.company_name || lead.company_name || 'Cliente';
      const billDescription = `Locação - Contrato ${contract.contract_number || 'N/A'} - ${clientDisplayName}`;

      const { error: billError } = await supabase
        .from('bills')
        .insert({
          origin: 'MANUAL',
          type: 'receivable',
          rental_invoice_id: newInvoice.id,
          client_id: resolvedClientId,
          counterparty_name: clientDisplayName,
          description: billDescription,
          gross_value: totalValue,
          net_value: totalValue,
          fee_amount: 0,
          due_date: finalDueDate || new Date().toISOString().split('T')[0],
          status: 'Pendente',
          created_by: req.user?.id || null
        });

      if (billError) {
        console.error('[finishProcessing] Erro ao criar lançamento em bills para faturamento manual:', billError);
      }
    }

    // 3. Atualizar status do contrato e vincular rental_invoice_id
    const { data: updatedContract, error: updateError } = await supabase
      .from('crm_deal_contracts')
      .update({
        status: 'Processado',
        rental_invoice_id: newInvoice.id,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    // 4. Atualizar o status de todos os equipamentos selecionados para 'Locado'
    if (equipmentIds.length > 0) {
      const { error: eqUpdateError } = await supabase
        .from('equipments')
        .update({ status: 'Locado', updated_at: new Date().toISOString() })
        .in('id', equipmentIds);
      if (eqUpdateError) {
        console.error('[logisticsController] Erro ao atualizar status dos equipamentos para Locado:', eqUpdateError);
      }
    }

    res.json(updatedContract);
  } catch (error: any) {
    console.error('[logisticsController] Erro em finishProcessing:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor' });
  }
};

/**
 * POST /api/logistics/contracts/:id/triage-photos
 * Saves a triage photo record and creates a signed URL for the uploaded file.
 * Body: { position: number, label: string, file_path: string, equipment_id?: string }
 */
export const saveTriagePhoto = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const contractId = req.params.id;
    const { position, label, file_path, equipment_id } = req.body;

    if (!position || !label || !file_path) {
      return res.status(400).json({ error: 'position, label e file_path são obrigatórios.' });
    }

    // Create a signed URL (10 years)
    const { data: urlData, error: urlError } = await supabase.storage
      .from('logistics-triage')
      .createSignedUrl(file_path, 60 * 60 * 24 * 365 * 10);

    if (urlError) throw urlError;

    // Upsert to allow re-upload of the same position for this equipment/contract
    const { data, error } = await supabase
      .from('logistics_triage_photos')
      .upsert({
        contract_id: contractId,
        equipment_id: equipment_id || null,
        position,
        label,
        file_path,
        file_url: urlData?.signedUrl,
        uploaded_by: req.user?.id,
        uploaded_at: new Date().toISOString()
      }, { onConflict: 'contract_id,equipment_id,position' })
      .select(`
        *,
        uploaded_by_user:users_profiles!logistics_triage_photos_uploaded_by_fkey(
          id,
          full_name,
          email
        )
      `)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('[logisticsController] Erro em saveTriagePhoto:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor' });
  }
};

/**
 * GET /api/logistics/contracts/:id/triage-photos
 * Returns all triage photos for a contract (optionally filtered by equipment_id) ordered by position.
 */
export const getTriagePhotos = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const contractId = req.params.id;
    const equipmentId = req.query.equipment_id as string | undefined;

    let query = supabase
      .from('logistics_triage_photos')
      .select(`
        *,
        uploaded_by_user:users_profiles!logistics_triage_photos_uploaded_by_fkey(
          id,
          full_name,
          email
        )
      `)
      .eq('contract_id', contractId);

    if (equipmentId) {
      query = query.eq('equipment_id', equipmentId);
    }

    const { data, error } = await query.order('position', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (error: any) {
    console.error('[logisticsController] Erro em getTriagePhotos:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor' });
  }
};

/**
 * DELETE /api/logistics/contracts/:id/triage-photos/:photoId
 * Deletes a triage photo record and its file from storage.
 */
export const deleteTriagePhoto = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { photoId } = req.params;

    // Fetch photo to get file_path
    const { data: photo, error: fetchError } = await supabase
      .from('logistics_triage_photos')
      .select('file_path')
      .eq('id', photoId)
      .single();

    if (fetchError) throw fetchError;
    if (!photo) return res.status(404).json({ error: 'Foto não encontrada' });

    // Delete from storage
    await supabase.storage.from('logistics-triage').remove([photo.file_path]);

    // Delete from database
    const { error } = await supabase
      .from('logistics_triage_photos')
      .delete()
      .eq('id', photoId);

    if (error) throw error;
    res.json({ success: true });
  } catch (error: any) {
    console.error('[logisticsController] Erro em deleteTriagePhoto:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor' });
  }
};
